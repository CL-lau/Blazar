import type { DesktopAppControls, RunOutcome, Task, TaskAttachment, WorkerConfiguration } from '../../packages/protocol/task.ts';
import { ConversationError, createConversationRouter } from './application/conversation.ts';
import { artifactDiff } from './artifact-diff.ts';
import { workerCatalog } from '../../packages/workers/registry.ts';
import { performance } from 'node:perf_hooks';
import { RouterMetrics, type StreamHealth } from './metrics.ts';
import { documentAppCatalog, documentCapabilityState, DocumentAccessDenied, DocumentUnavailable, type DocumentConnector } from '../../packages/apps/documents.ts';
import { WebSocket, WebSocketServer } from 'ws';
import { createQQHandler, qqChannel, type QQConfig } from '../../packages/channels/qq.ts';
import { feishuChannel, parseFeishu, type FeishuConfig } from '../../packages/channels/feishu.ts';
import { InvalidWorkflow, workflowSteps } from './domain/workflow.ts';
import type { MemoryAnswer, RouteRequest, RouterHarness } from './harness.ts';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { MemoryStore, ResourceRef } from './memory.ts';
import { IdempotencyConflict, TaskStore, type AppEvidence } from './store.ts';

class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requiredText(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new RequestError(400, `Invalid ${field}`);
  }
  return value;
}

const maxDeviceFinishBytes = 1_350_000;
const maxDeviceClaimBytes = 400_000;

async function jsonBody(request: IncomingMessage, limit = 65_536) {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new RequestError(415, 'Expected application/json');
  }
  let size = 0;
  const buffers: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new RequestError(413, 'Request too large');
    }
    buffers.push(chunk);
  }
  try {
    const raw = Buffer.concat(buffers);
    const data = JSON.parse(raw.toString());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return { body: data as Record<string, unknown>, raw };
  } catch {
    throw new RequestError(400, 'Expected a JSON object');
  }
}

async function jsonObject(request: IncomingMessage, limit?: number) {
  return (await jsonBody(request, limit)).body;
}

function reply(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function stream(store: TaskStore, owner: string, cursor: number, response: ServerResponse, authorized: () => boolean,
                      once: boolean, canReadTask: (taskId: string) => boolean, replayThrough: number, metrics: RouterMetrics) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  response.flushHeaders();
  metrics.recordStream('opened');
  const controller = new AbortController();
  response.once('close', () => controller.abort());
  const deadline = Date.now() + 25_000;
  try {
    while (!controller.signal.aborted && Date.now() < deadline && authorized()) {
      if (cursor < store.eventReplayFloor()) {
        metrics.recordStream('resnapshotRequired');
        return;
      }
      const events = store.events(owner, cursor);
      for (const event of events) {
        const frame = JSON.stringify({ ...event, data: canReadTask(event.taskId) ? JSON.parse(event.data) : {} });
        const writable = response.write(`id: ${event.seq}\nevent: task\ndata: ${frame}\n\n`);
        if (event.seq <= replayThrough) metrics.recordStream('replayedEvents');
        if (!writable || once) return;
        cursor = event.seq;
      }
      if (!events.length) await delay(250, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    response.end();
  }
}

function textAttachments(value: unknown): TaskAttachment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new RequestError(400, 'Invalid task attachments');
  let bytes = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RequestError(400, 'Invalid task attachment');
    const name = requiredText(item.name, 'attachment name', 128);
    const text = requiredText(item.text, 'attachment text', 8_192).toWellFormed();
    bytes += Buffer.byteLength(text);
    if (/[\x00-\x1f\x7f/\\]/.test(name) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || bytes > 16_384) {
      throw new RequestError(400, 'Invalid task attachment text or size');
    }
    return { name: name.toWellFormed(), text };
  });
}

function selectAppEvidence(memory: MemoryStore | undefined, owner: string, workspace: string, value: unknown): AppEvidence {
  if (!memory) throw new RequestError(503, 'Memory is unavailable');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'Invalid application memory option');
  }
  const { query: rawQuery, sources: rawSources } = value as Record<string, unknown>;
  const query = requiredText(rawQuery, 'search terms', 256);
  if (!Array.isArray(rawSources) || !rawSources.length || rawSources.length > 25 ||
      rawSources.some(item => typeof item !== 'string' || !/^[a-f0-9-]{36}$/.test(item))) {
    throw new RequestError(400, 'Invalid source filter');
  }
  const sources = [...new Set(rawSources as string[])].sort();
  const refs = memory.recall(owner, workspace, query, sources, false, false).slice(0, 4)
    .map(item => ({ id: String(item.id), version: Number(item.version) }));
  if (!refs.length) throw new RequestError(409, 'No authorized application evidence was found');
  return { query, sources, refs };
}

async function accessDocument(store: MemoryStore, owner: string, workspace: string, connection: string,
                              reader: DocumentConnector, document: string, operation: 'test' | 'import' | 'refresh',
                              signal?: AbortSignal, permitted = () => true) {
  if (!permitted()) throw new RequestError(409, 'Document refresh was cancelled');
  if (store.resourceRevoked(connection, document)) throw new RequestError(409, 'Document access was revoked');
  if (!reader.accepts(document)) throw new RequestError(400, 'Invalid document reference');
  const usageId = store.startAppUsage(connection, workspace, operation);
  let content;
  try {
    const timeout = AbortSignal.timeout(10_000);
    content = await reader.read(document, signal ? AbortSignal.any([timeout, signal]) : timeout);
  } catch (error) {
    if (error instanceof DocumentAccessDenied && permitted()) store.recordDocumentAccess(connection, document, usageId, false);
    store.finishAppUsage(usageId, !permitted() ? 'access_changed' :
      error instanceof DocumentAccessDenied ? 'access_denied' : 'failed');
    throw new RequestError(502, error instanceof DocumentUnavailable ? error.message : 'Document read failed');
  }
  if (!permitted()) {
    store.finishAppUsage(usageId, 'access_changed');
    throw new RequestError(409, 'Document refresh was cancelled');
  }
  if (operation === 'test') {
    if (!store.connection(owner, connection, workspace) || store.resourceRevoked(connection, document)) {
      store.finishAppUsage(usageId, 'access_changed');
      throw new RequestError(409, 'Source access changed during the test');
    }
    store.finishAppUsage(usageId, 'succeeded');
    return { readable: true };
  }
  const id = store.importDocument(owner, workspace, content.text, {
    connection, resource: document, revision: content.revision,
  }, usageId);
  store.finishAppUsage(usageId, id ? 'succeeded' : 'access_changed');
  if (!id) throw new RequestError(409, 'Source access changed during import');
  return { id, revision: content.revision };
}

async function refreshDocumentPage(store: MemoryStore, owner: string, workspace: string, connection: string,
                                   reader: DocumentConnector, cursor: string, signal?: AbortSignal, permitted?: () => boolean) {
  const documents = store.documentsToRefresh(owner, workspace, connection, cursor);
  const page = documents.slice(0, 8);
  const results = await Promise.allSettled(page.map(document =>
    accessDocument(store, owner, workspace, connection, reader, document, 'refresh', signal, permitted)));
  const refreshed = results.filter(result => result.status === 'fulfilled').length;
  return { refreshed, unavailable: results.length - refreshed, after: documents.length > page.length ? page.at(-1)! : null };
}

export async function runDueDocumentSync(store: MemoryStore, readers: readonly DocumentConnector[],
                                         signal: AbortSignal, now = Date.now()) {
  if (signal.aborted) return false;
  const sync = store.leaseDocumentSync(now);
  if (!sync) return false;
  const connection = store.connection(sync.owner, sync.connection, sync.workspace);
  const reader = readers.find(item => item.app === connection?.app && item.account === connection.account);
  const permitted = () => !signal.aborted && store.documentSyncActive(sync);
  const page = reader && permitted() ? await refreshDocumentPage(
    store, sync.owner, sync.workspace, sync.connection, reader, sync.cursor, signal, permitted,
  ) : undefined;
  store.finishDocumentSync(sync, signal.aborted ? sync.cursor : page?.after ?? null);
  return true;
}

async function handleMemory(
  request: IncomingMessage, response: ServerResponse, url: URL, owner: string, store: MemoryStore, documents?: readonly DocumentConnector[], answerMemory?: MemoryAnswer,
): Promise<boolean> {
  const { pathname, searchParams } = url;
  const method = request.method;
  const readerFor = (connection: { app: string; account: string }) =>
    documents?.find(connector => connector.app === connection.app && connector.account === connection.account);
  if (pathname === '/v1/app-connections') {
    if (method === 'GET') {
      reply(response, 200, {
        definitions: documentAppCatalog(documents ?? []),
        documentSync: store.documentSyncSettings(owner),
        connections: store.connections(owner).map(connection => {
          const reader = readerFor(connection);
          return {
            ...connection,
            canImportDocument: Boolean(connection.active && reader),
            documentAliases: connection.active ? reader?.documentAliases : undefined,
            capabilities: documentCapabilityState(connection, reader),
          };
        }),
      });
      return true;
    }
    if (method === 'POST') {
      const data = await jsonObject(request);
      const app = requiredText(data.app, 'app', 128);
      const account = requiredText(data.account, 'account', 256);
      const workspace = data.workspace === undefined ? undefined : requiredText(data.workspace, 'workspace', 128);
      reply(response, 201, { id: store.connect(owner, app, account, workspace) });
      return true;
    }
  }

  const syncPath = /^\/v1\/app-connections\/([a-f0-9-]{36})\/document-sync$/.exec(pathname);
  if (syncPath && method === 'POST') {
    const data = await jsonObject(request);
    const workspace = requiredText(data.workspace, 'workspace', 128);
    const interval = data.intervalMinutes;
    if (interval !== null && (typeof interval !== 'number' || !Number.isSafeInteger(interval) ||
        interval < 1 || interval > 10_080)) throw new RequestError(400, 'Invalid document refresh interval');
    const connection = store.connection(owner, syncPath[1], workspace);
    if (!connection) throw new RequestError(404, 'Active connection not found');
    if (interval !== null && !readerFor(connection)) throw new RequestError(409, 'No document reader is configured for this connection');
    store.setDocumentSync(owner, syncPath[1], workspace, interval);
    reply(response, 200, { intervalMinutes: interval });
    return true;
  }

  const usagePath = /^\/v1\/app-connections\/([a-f0-9-]{36})\/usage$/.exec(pathname);
  if (usagePath && method === 'GET') {
    const usage = store.appUsage(owner, usagePath[1]);
    if (!usage) throw new RequestError(404, 'Connection not found');
    reply(response, 200, { usage });
    return true;
  }

  const documentPath = /^\/v1\/app-connections\/([a-f0-9-]{36})\/(import-document|test-document|refresh-documents)$/.exec(pathname);
  if (documentPath && method === 'POST') {
    const data = await jsonObject(request);
    const workspace = requiredText(data.workspace, 'workspace', 128);
    const connectionId = documentPath[1];
    const connection = store.connection(owner, connectionId, workspace);
    if (!connection) throw new RequestError(404, 'Active connection not found');
    const reader = readerFor(connection);
    if (!reader) throw new RequestError(409, 'No document reader is configured for this connection');
    if (documentPath[2] === 'refresh-documents') {
      const after = data.after === undefined ? '' : requiredText(data.after, 'document cursor', 128);
      reply(response, 200, await refreshDocumentPage(store, owner, workspace, connectionId, reader, after));
      return true;
    }
    const document = requiredText(data.document, 'document ID', 128);
    reply(response, 200, await accessDocument(store, owner, workspace, connectionId, reader, document,
      documentPath[2] === 'test-document' ? 'test' : 'import'));
    return true;
  }

  const revokeDocument = /^\/v1\/app-connections\/([a-f0-9-]{36})\/revoke-resource$/.exec(pathname);
  if (revokeDocument && method === 'POST') {
    const data = await jsonObject(request);
    const resource = requiredText(data.resource, 'resource', 512);
    const removed = store.revokeResource(owner, revokeDocument[1], resource);
    if (removed === undefined) throw new RequestError(404, 'Active connection not found');
    reply(response, 200, { removed });
    return true;
  }

  const connectionPath = /^\/v1\/app-connections\/([a-f0-9-]+)$/.exec(pathname);
  if (connectionPath && method === 'PATCH') {
    const data = await jsonObject(request);
    const workspace = data.workspace === null ? null : requiredText(data.workspace, 'workspace', 128);
    if (!store.setConnectionWorkspace(owner, connectionPath[1], workspace)) {
      throw new RequestError(404, 'Active connection not found');
    }
    reply(response, 200, { workspace });
    return true;
  }
  if (connectionPath && method === 'DELETE') {
    if (!store.disconnect(owner, connectionPath[1])) throw new RequestError(404, 'Active connection not found');
    reply(response, 200, { disconnected: true });
    return true;
  }

  if (pathname === '/v1/memory/answer' && method === 'POST') {
    const data = await jsonObject(request);
    const workspace = requiredText(data.workspace, 'workspace', 128);
    const query = requiredText(data.query, 'search terms', 256);
    const question = requiredText(data.question, 'question', 4_000);
    if (!Array.isArray(data.sources) || data.sources.length > 25 ||
        data.sources.some(source => typeof source !== 'string' || !/^[a-f0-9-]{36}$/.test(source))) {
      throw new RequestError(400, 'Invalid source filter');
    }
    const selected = data.sources as string[];
    if (data.includePersonal !== undefined && typeof data.includePersonal !== 'boolean') {
      throw new RequestError(400, 'Invalid personal memory option');
    }
    const recall = () => store.recall(owner, workspace, query, selected, false, data.includePersonal !== false).slice(0, 6);
    const sources = recall();
    if (!sources.length) {
      reply(response, 200, { answer: null, sources: [] });
      return true;
    }
    if (!answerMemory) throw new RequestError(503, 'Blazar has no Router model configured');
    const evidence = sources.map(row => ({
      id: String(row.id), body: String(row.body).slice(0, 2_000).toWellFormed(),
      resource: row.resource === null ? null : String(row.resource),
      revision: row.revision === null ? null : String(row.revision),
    }));
    let answer: string;
    try {
      answer = (await answerMemory(question, evidence, AbortSignal.timeout(15_000))).trim();
      if (!answer || answer.length > 8_000) throw new Error('Invalid model response');
    } catch {
      throw new RequestError(503, 'Blazar could not answer from memory. Please retry.');
    }
    const current = recall();
    if (sources.some(row => !current.some(item => item.id === row.id && item.version === row.version))) {
      throw new RequestError(409, 'Memory sources changed while answering. Run the search again.');
    }
    reply(response, 200, { answer, sources: sources.map(({ id, connection, resource, revision }) => ({
      id, connection, resource, revision,
    })) });
    return true;
  }

  if (pathname === '/v1/memory' && method === 'GET') {
    const workspace = requiredText(searchParams.get('workspace'), 'workspace', 128);
    const query = requiredText(searchParams.get('q'), 'query', 256);
    const sources = searchParams.getAll('source');
    if (sources.length > 25 || sources.some(source => !/^[a-f0-9-]{36}$/.test(source))) {
      throw new RequestError(400, 'Invalid source filter');
    }
    const state = searchParams.get('state') ?? 'active';
    if (state !== 'active' && state !== 'disabled') throw new RequestError(400, 'Invalid memory state');
    reply(response, 200, { items: store.recall(owner, workspace, query, sources, state === 'disabled') });
    return true;
  }
  if (pathname === '/v1/memory' && method === 'POST') {
    const data = await jsonObject(request);
    const workspace = requiredText(data.workspace, 'workspace', 128);
    const body = requiredText(data.body, 'body', 16_000);
    const expires = data.expires;
    if (expires !== undefined && (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= Date.now())) {
      throw new RequestError(400, 'Invalid expiry');
    }
    let source: ResourceRef | undefined;
    if (data.source !== undefined) {
      if (!data.source || typeof data.source !== 'object' || Array.isArray(data.source)) {
        throw new RequestError(400, 'Invalid source');
      }
      const ref = data.source as Record<string, unknown>;
      source = {
        connection: requiredText(ref.connection, 'connection', 36),
        resource: requiredText(ref.resource, 'resource', 512),
        revision: requiredText(ref.revision, 'revision', 256),
      };
    }
    const id = store.remember(owner, workspace, body, source, expires);
    if (!id) throw new RequestError(404, 'Active source connection not found');
    reply(response, 201, { id });
    return true;
  }

  const historyPath = /^\/v1\/memory\/([a-f0-9-]{36})\/history$/.exec(pathname);
  if (historyPath && method === 'GET') {
    const history = store.history(owner, historyPath[1]);
    if (!history) throw new RequestError(404, 'Memory not found');
    reply(response, 200, history);
    return true;
  }

  const remove = /^\/v1\/memory\/([a-f0-9-]{36})$/.exec(pathname);
  if (remove && method === 'PATCH') {
    const data = await jsonObject(request);
    const version = data.expectedVersion;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 ||
        (data.pinned !== undefined && typeof data.pinned !== 'boolean') ||
        (data.disabled !== undefined && typeof data.disabled !== 'boolean') ||
        (data.pinned === undefined && data.disabled === undefined && data.body === undefined)) {
      throw new RequestError(400, 'Invalid memory update');
    }
    const body = data.body === undefined ? undefined : requiredText(data.body, 'body', 16_000);
    const result = store.revise(owner, remove[1], version, { body, pinned: data.pinned, disabled: data.disabled });
    if (!result) throw new RequestError(404, 'Memory not found');
    reply(response, result.conflict ? 409 : 200, result.conflict
      ? { error: 'Memory changed. Run the search again.', version: result.version }
      : { version: result.version });
    return true;
  }
  if (remove && method === 'DELETE') {
    if (!store.remove(owner, remove[1])) throw new RequestError(404, 'Memory not found');
    reply(response, 200, { deleted: true });
    return true;
  }
  return false;
}

function workerMemoryAvailable(store: TaskStore, memory: MemoryStore | undefined, owner: string, workspace: string, taskId: string) {
  const app = store.appEvidence(taskId);
  const personal = store.personalEvidence(taskId);
  return (!app || Boolean(memory?.resolveAppEvidence(owner, workspace, app))) &&
    (!personal.length || Boolean(memory?.resolvePersonalEvidence(owner, workspace, personal)));
}

function deviceOperation(store: TaskStore, bearer: string, pathname: string, data: Record<string, unknown>, expireRuns: (now: number) => number, memory?: MemoryStore) {
  const device = store.deviceForToken(bearer);
  if (!device) throw new RequestError(401, 'Device authentication required');
  const now = Date.now();
  const leaseMs = 45_000;
  if (pathname === '/v1/device/interrupted') {
    const runId = requiredText(data.runId, 'run ID', 36);
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new RequestError(400, 'Invalid run ID');
    store.reportInterruption(device.id, runId, now);
    return { status: 200, body: { recorded: true } };
  }
  if (pathname === '/v1/device/claim') {
    if (data.capability !== undefined && data.capability !== 'document.preview' && data.capability !== 'agent.acp' && data.capability !== 'computer.observe') {
      throw new RequestError(400, 'Unknown capability');
    }
    const key = data.requestId;
    if (key !== undefined && (typeof key !== 'string' || !/^[a-f0-9-]{36}$/.test(key))) {
      throw new RequestError(400, 'Invalid claim request ID');
    }
    const platform = data.platform === undefined ? undefined : requiredText(data.platform, 'device platform', 32);
    let worker: WorkerConfiguration | undefined;
    if (data.worker !== undefined) {
      if (data.capability !== 'agent.acp' || !data.worker || typeof data.worker !== 'object' || Array.isArray(data.worker)) {
        throw new RequestError(400, 'Unexpected Worker metadata');
      }
      const reported = data.worker as Record<string, unknown>;
      const protocol = requiredText(reported.protocol, 'Worker protocol', 16);
      if (!['acp', 'codex', 'claude', 'pi', 'aider', 'jsonl'].includes(protocol)) {
        throw new RequestError(400, 'Unknown Worker protocol');
      }
      const label = requiredText(reported.label, 'Worker label', 128);
      if (/[\x00-\x1f\x7f]/.test(label)) throw new RequestError(400, 'Invalid Worker label');
      worker = { label, protocol };
      if (reported.adapterVersion !== undefined || reported.revision !== undefined) {
        if (reported.adapterVersion !== 1 || typeof reported.revision !== 'string' ||
            !/^[a-f0-9]{64}$/.test(reported.revision)) throw new RequestError(400, 'Invalid Worker revision');
        worker.adapterVersion = reported.adapterVersion;
        worker.revision = reported.revision;
      }
    }
    let desktopApps: string[] | undefined;
    if (data.desktopApps !== undefined) {
      if (data.capability !== 'computer.observe' || !Array.isArray(data.desktopApps) || data.desktopApps.length > 25 ||
          data.desktopApps.some(alias => typeof alias !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(alias))) {
        throw new RequestError(400, 'Invalid desktop application aliases');
      }
      desktopApps = [...new Set(data.desktopApps as string[])].sort();
    }
    let desktopPermissions: Record<string, string> | undefined;
    if (data.desktopPermissions !== undefined) {
      if (!desktopApps || !data.desktopPermissions || typeof data.desktopPermissions !== 'object' ||
          Array.isArray(data.desktopPermissions)) throw new RequestError(400, 'Invalid desktop permissions');
      const states = data.desktopPermissions as Record<string, unknown>;
      desktopPermissions = {};
      for (const name of ['accessibility', 'screen_recording', 'automation']) {
        const state = states[name];
        if (typeof state !== 'string' || !/^[a-z_]{1,32}$/.test(state)) {
          throw new RequestError(400, 'Invalid desktop permission state');
        }
        desktopPermissions[name] = state;
      }
    }
    let desktopControls: DesktopAppControls[] | undefined;
    if (data.desktopControls !== undefined) {
      if (!desktopApps || !Array.isArray(data.desktopControls) || data.desktopControls.length !== desktopApps.length) {
        throw new RequestError(400, 'Invalid desktop controls');
      }
      const remaining = new Set(desktopApps);
      desktopControls = data.desktopControls.map(entry => {
        if (!entry || typeof entry !== 'object' || !remaining.delete(entry.alias) ||
            typeof entry.visual !== 'boolean' || !Array.isArray(entry.buttons) || entry.buttons.length > 25 ||
            entry.buttons.some((label: unknown) => typeof label !== 'string' || !label.trim()
              || label.length > 120 || /[\x00-\x1f\x7f]/.test(label))) {
          throw new RequestError(400, 'Invalid desktop controls');
        }
        return { alias: entry.alias, visual: entry.visual, buttons: [...new Set<string>(entry.buttons)] };
      });
    }
    store.recordDesktopApps(device.id, desktopApps, desktopPermissions, desktopControls);
    store.recordDeviceWorker(device.id, worker);
    store.recordDeviceActivity(device.id, now, data.capability, platform);
    expireRuns(now);
    const claim = store.claim(device.owner, device.workspace, device.id, now, leaseMs,
      data.capability === 'document.preview' ? '/preview ' : data.capability === 'computer.observe' ? '/observe ' : '',
      data.capability === 'agent.acp' ? '/preview ' : '', key, worker, desktopApps, data.capability === 'agent.acp');
    if (!claim) {
      store.clearInterruption(device.id);
      return { status: 200, body: { assignment: null } };
    }
    const { replayed, ...assignment } = claim;
    const personal = assignment.memoryInputs?.map(({ id, version }) => ({ id, version })) ?? [];
    const app = store.appEvidence(assignment.task.id);
    if (personal.length || app) {
      const personalEvidence = personal.length ? memory?.resolvePersonalEvidence(device.owner, device.workspace, personal) : [];
      const appEvidence = app ? memory?.resolveAppEvidence(device.owner, device.workspace, app) : [];
      if (data.capability !== 'agent.acp' || !memory || !personalEvidence || !appEvidence) {
        if (replayed) store.requestRunEvidenceStop(assignment.run.id, device.id);
        else store.rejectRunEvidence(assignment.run.id, device.id);
        return { status: 200, body: { assignment: null } };
      }
      if (appEvidence.length) memory.recordWorkerAppUsage(device.workspace, assignment.task.id, assignment.run.id,
        [...new Set(appEvidence.map(input => input.connection))]);
      assignment.memoryInputs = [...personalEvidence, ...appEvidence.map(({ id, body, version }) => ({ id, body, version }))];
    }
    store.clearInterruption(device.id);
    return { status: 200, body: { assignment, leaseRemainingMs: Math.max(0, assignment.run.expires - Date.now()) } };
  }
  const run = /^\/v1\/device\/runs\/([a-f0-9-]{36})\/(renew|finish|stopped|request-approval|approval|consume-approval|progress|input-artifact|steer)$/.exec(pathname);
  if (!run) throw new RequestError(404, 'Route not found');
  if (['renew', 'finish', 'progress', 'request-approval', 'approval', 'consume-approval', 'input-artifact', 'steer'].includes(run[2])) {
    const taskId = store.runTaskId(run[1], device.id);
    if (store.runEvidenceStopping(run[1]) ||
        (taskId && !workerMemoryAvailable(store, memory, device.owner, device.workspace, taskId))) {
      if (run[2] === 'finish') store.rejectRunEvidence(run[1], device.id);
      else store.requestRunEvidenceStop(run[1], device.id);
      return { status: 409, body: { accepted: false } };
    }
  }
  if (run[2] === 'input-artifact') {
    const artifactId = requiredText(data.artifactId, 'artifact ID', 36);
    if (!/^[a-f0-9-]{36}$/.test(artifactId)) throw new RequestError(400, 'Invalid artifact ID');
    const artifact = store.runInputArtifact(run[1], device.id, artifactId, now);
    if (!artifact) throw new RequestError(404, 'Run input artifact not found');
    const { content, ...identity } = artifact;
    return { status: 200, body: { ...identity, text: Buffer.from(content).toString('utf8') } };
  }
  if (run[2] === 'stopped') {
    const accepted = store.acknowledgeStop(run[1], device.id, now);
    return { status: accepted ? 200 : 409, body: { accepted } };
  }
  if (run[2] === 'steer') {
    const version = data.appliedVersion;
    if (version !== undefined && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)) {
      throw new RequestError(400, 'Invalid instruction version');
    }
    const result = store.steering(run[1], device.id, now, version);
    return { status: result ? 200 : 409, body: result ?? { accepted: false } };
  }
  if (run[2] === 'progress') {
    const seq = data.seq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || seq > 10_000) {
      throw new RequestError(400, 'Invalid progress sequence');
    }
    const accepted = store.progress(run[1], device.id, now, seq, requiredText(data.message, 'message', 1_024));
    return { status: accepted ? 200 : 409, body: { accepted } };
  }
  if (run[2] === 'request-approval') {
    const approval = store.requestApproval(run[1], device.id, requiredText(data.summary, 'summary', 4_000), now);
    return { status: approval ? 200 : 409, body: { approval: approval ?? null } };
  }
  if (run[2] === 'consume-approval') {
    const accepted = store.consumeApproval(run[1], device.id, requiredText(data.approvalId, 'approval ID', 36), now);
    return { status: accepted ? 200 : 409, body: { accepted } };
  }
  if (run[2] === 'approval') {
    const approval = store.approvalForRun(run[1], device.id, requiredText(data.approvalId, 'approval ID', 36), now);
    return { status: approval ? 200 : 404, body: { decision: approval?.decision ?? null } };
  }
  if (run[2] === 'renew') {
    store.recordDeviceActivity(device.id, now);
    const expires = store.renew(run[1], device.id, now, leaseMs);
    if (expires === undefined) return { status: 409, body: { renewed: false } };
    return { status: 200, body: { renewed: true, leaseRemainingMs: Math.max(0, expires - Date.now()) } };
  }
  if (data.status !== 'succeeded' && data.status !== 'failed' && data.status !== 'waiting_user') {
    throw new RequestError(400, 'Invalid outcome status');
  }
  let artifact: RunOutcome['artifact'];
  if (data.artifact !== undefined) {
    if (data.status !== 'succeeded' || !data.artifact || typeof data.artifact !== 'object' || Array.isArray(data.artifact)) {
      throw new RequestError(400, 'Invalid artifact');
    }
    const file = data.artifact as Record<string, unknown>;
    const name = requiredText(file.name, 'artifact name', 128);
    if (typeof file.text !== 'string') throw new RequestError(400, 'Invalid artifact content');
    if (file.mime === 'image/png') {
      if (file.text.length > 1_333_336) throw new RequestError(400, 'Window image is too large');
      const png = Buffer.from(file.text, 'base64');
      if (png.length < 33 || png.length > 1_000_000 || png.toString('base64') !== file.text ||
          png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(8) !== 13 ||
          png.toString('ascii', 12, 16) !== 'IHDR' || !png.readUInt32BE(16) || !png.readUInt32BE(20) ||
          png.readUInt32BE(16) * png.readUInt32BE(20) > 16_000_000) {
        throw new RequestError(400, 'Invalid window image');
      }
      artifact = { name, text: file.text, mime: file.mime };
    } else {
      if (file.mime !== undefined || Buffer.byteLength(file.text) > 32_000) {
        throw new RequestError(400, 'Invalid artifact content');
      }
      artifact = { name, text: file.text };
    }
  }
  const accepted = store.finish(run[1], device.id, now, {
    status: data.status,
    result: requiredText(data.result, 'result', 32_000),
    artifact,
  });
  return { status: accepted ? 200 : 409, body: { accepted } };
}

type StreamChannelSettings = Partial<Record<'weixin' | 'wecom' | 'dingtalk', { workspace: string; health?: () => StreamHealth | undefined }>>;

export function routerServer(store: TaskStore, config: { owner: string; token: string; memory?: MemoryStore; harness?: RouterHarness; feishu?: FeishuConfig; lark?: FeishuConfig; readLarkAttachment?: (messageId: string, key: string) => Promise<string | undefined>; readFeishuAttachment?: (messageId: string, key: string) => Promise<string | undefined>; qq?: QQConfig; readQQAttachment?: (url: string, name?: string) => Promise<TaskAttachment | undefined>; documents?: readonly DocumentConnector[]; answerMemory?: MemoryAnswer; pushEnabled?: boolean; streamChannels?: StreamChannelSettings }) {
  const metricsByOwner = new Map<string, RouterMetrics>();
  function ownerMetrics(owner: string) {
    let metrics = metricsByOwner.get(owner);
    if (!metrics) {
      metrics = new RouterMetrics();
      metricsByOwner.set(owner, metrics);
    }
    return metrics;
  }
  const routeConversation = createConversationRouter(store, config);
  const stopSubscribers = new Map<string, Set<WebSocket>>();
  function sendStop(device: string, runId: string) {
    for (const peer of stopSubscribers.get(device) ?? []) {
      if (peer.readyState === WebSocket.OPEN && peer.bufferedAmount < 256_000) {
        peer.send(JSON.stringify({ type: 'run.stop', runId }));
      }
    }
  }
  const expireRuns = (now: number) => store.expire(now, sendStop);
  function notifyStop(owner: string, taskId: string) {
    const target = store.stopTarget(owner, taskId);
    if (target) sendStop(target.device, target.runId);
  }
  async function attachFromChannel(channel: string, workspace: string,
                                   message: Parameters<TaskStore['channelAttachmentTask']>[3],
                                   download: () => Promise<TaskAttachment | undefined>) {
    const task = store.channelAttachmentTask(config.owner, channel, workspace, message);
    if (!task) return;
    let file;
    try { file = await download(); }
    catch { throw new RequestError(503, 'Attachment download failed'); }
    if (!file) return;
    let attachment: TaskAttachment;
    try { [attachment] = textAttachments([file]); }
    catch (error) {
      if (error instanceof RequestError) return;
      throw error;
    }
    if (store.addChannelAttachment(config.owner, channel, workspace, String(task.id), message, attachment)) {
      notifyStop(config.owner, String(task.id));
    }
  }
  function flushStopNotifications() {
    const checked = new Map<string, boolean>();
    for (const task of store.pendingMemoryTasks()) {
      const key = JSON.stringify([task.owner, task.workspace, task.appRefs, task.personalRefs]);
      let allowed = checked.get(key);
      if (allowed === undefined) {
        const personal = JSON.parse(task.personalRefs);
        allowed = (!task.appRefs || Boolean(config.memory?.resolveAppEvidence(task.owner, task.workspace, JSON.parse(task.appRefs)))) &&
          (!personal.length || Boolean(config.memory?.resolvePersonalEvidence(task.owner, task.workspace, personal)));
        checked.set(key, allowed);
      }
      if (!allowed) {
        if (task.run) store.requestRunEvidenceStop(task.run.id, task.run.device);
        else store.suspendTaskForMemory(task.id);
      }
    }
    for (const device of stopSubscribers.keys()) {
      for (const row of store.deviceStopTargets(device)) sendStop(device, String(row.id));
    }
  }
  const expected = Buffer.from(`Bearer ${config.token}`);
  const qq = config.qq ? createQQHandler(config.qq) : undefined;
  const server = createServer(async (request, response) => {
    const started = performance.now();
    try {
      const auth = request.headers.authorization ?? '';
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/v1/channels/qq/events' && qq && config.qq) {
        const { body, raw } = await jsonBody(request);
        const event = qq(body, raw, request.headers['x-signature-timestamp'],
          request.headers['x-signature-ed25519'], Date.now());
        if (event.kind === 'unauthorized') throw new RequestError(401, 'Channel authentication required');
        if (event.kind === 'challenge') {
          reply(response, 200, { plain_token: event.plain_token, signature: event.signature });
        } else {
          if (event.kind === 'message') {
            store.receiveChannelMessage(config.owner, qqChannel(config.qq),
              config.qq.workspace, event.message);
            flushStopNotifications();
            ownerMetrics(config.owner).observe('qq', performance.now() - started);
          }
          if (event.kind === 'attachment' && config.readQQAttachment) {
            const read = config.readQQAttachment;
            await attachFromChannel(qqChannel(config.qq), config.qq.workspace, event.message, () => read(event.url, event.name));
          }
          reply(response, 200, { op: 12 });
        }
        return;
      }
      const larkCallback = url.pathname === '/v1/channels/lark/events';
      const collaboration = larkCallback ? config.lark : url.pathname === '/v1/channels/feishu/events' ? config.feishu : undefined;
      if (request.method === 'POST' && collaboration) {
        const channel = feishuChannel(collaboration, larkCallback ? 'lark' : 'feishu');
        const readAttachment = larkCallback ? config.readLarkAttachment : config.readFeishuAttachment;
        const event = parseFeishu(await jsonObject(request), collaboration);
        if (event.kind === 'unauthorized') throw new RequestError(401, 'Channel authentication required');
        if (event.kind === 'challenge') {
          reply(response, 200, { challenge: event.value });
          return;
        }
        if (event.kind === 'message') {
          store.receiveChannelMessage(config.owner, channel, collaboration.workspace, event);
          flushStopNotifications();
          ownerMetrics(config.owner).observe(larkCallback ? 'lark' : 'feishu', performance.now() - started);
        }
        if (event.kind === 'attachment' && readAttachment) {
          await attachFromChannel(channel, collaboration.workspace, event, async () => {
            const text = await readAttachment(event.id, event.key);
            return text === undefined ? undefined : { name: event.name, text };
          });
        }
        reply(response, 200, {});
        return;
      }
      if (url.pathname.startsWith('/v1/device/')) {
        if (request.method !== 'POST') throw new RequestError(405, 'Expected POST');
        if (!auth.startsWith('Bearer ')) throw new RequestError(401, 'Device authentication required');
        const result = deviceOperation(store, auth.slice(7), url.pathname, await jsonObject(request, url.pathname.endsWith('/finish') ? maxDeviceFinishBytes :
          url.pathname === '/v1/device/claim' ? maxDeviceClaimBytes : undefined), expireRuns, config.memory);
        reply(response, result.status, result.body);
        return;
      }
      if (url.pathname === '/v1/pairings/redeem' && request.method === 'POST') {
        const data = await jsonObject(request);
        const code = requiredText(data.code, 'code', 32);
        const name = requiredText(data.name, 'name', 128);
        const token = requiredText(data.token, 'device credential', 43);
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new RequestError(400, 'Invalid device credential');
        const pending = store.requestMobilePairing(code, name, token, Date.now());
        if (!pending) throw new RequestError(404, 'Pairing code is invalid or expired');
        reply(response, 202, pending);
        return;
      }
      if (url.pathname === '/v1/pairings/status' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id || !/^[a-f0-9-]{36}$/.test(id) || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) {
          throw new RequestError(404, 'Pairing request unavailable');
        }
        const state = store.mobilePairingState(id, auth.slice(7), Date.now());
        if (!state) throw new RequestError(404, 'Pairing request unavailable');
        reply(response, 200, { state });
        return;
      }
      const supplied = Buffer.from(auth);
      const publicGateway = request.headers['x-blazar-public-gateway'] === '1';
      const admin = !publicGateway && supplied.length === expected.length && timingSafeEqual(supplied, expected);
      const mobileToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const mobile = admin ? undefined : store.mobileIdentity(mobileToken);
      const owner = admin ? config.owner : mobile?.owner;
      if (!owner) throw new RequestError(401, 'Authentication required');
      const canReadTask = (taskId: string, resultVersion?: number) => {
        const app = store.appEvidence(taskId);
        const personal = store.personalEvidence(taskId);
        if (!app && !personal.length) return true;
        const task = store.get(owner, taskId);
        if (!task) return false;
        if (app && !admin && (!mobile || task.status !== 'succeeded' ||
            resultVersion === undefined || resultVersion !== task.version ||
            !store.canReadSharedResult(mobile.id, taskId, resultVersion))) return false;
        return (!app || Boolean(config.memory?.resolveAppEvidence(owner, task.workspace, app))) &&
          (!personal.length || Boolean(config.memory?.resolvePersonalEvidence(owner, task.workspace, personal)));
      };
      const protectedTaskLabel = 'Application-backed task';
      const taskResponse = (task: Task) => canReadTask(task.id) ? task : {
        ...task, ...(!admin && store.appEvidence(task.id) && { goal: protectedTaskLabel }), result: null,
      };
      if (!admin && (url.pathname.startsWith('/v1/admin/') || url.pathname === '/v1/pairings' ||
          url.pathname.startsWith('/v1/app-connections') || url.pathname.startsWith('/v1/memory'))) {
        throw new RequestError(403, 'Administrator required');
      }
      if (url.pathname === '/v1/mobile/push' && request.method === 'POST') {
        if (admin) throw new RequestError(403, 'Paired mobile client required');
        const { deviceToken } = await jsonObject(request);
        if (deviceToken !== null && (typeof deviceToken !== 'string' ||
            !/^(?:[a-f0-9]{2}){1,256}$/.test(deviceToken))) {
          throw new RequestError(400, 'Invalid APNs device token');
        }
        if (deviceToken !== null && !config.pushEnabled) throw new RequestError(503, 'Push is not configured');
        if (!store.registerPush(mobileToken, deviceToken)) throw new RequestError(409, 'Unable to register push on this pairing');
        reply(response, 200, { enabled: deviceToken !== null });
        return;
      }
      const taskLinks = /^\/v1\/admin\/tasks\/([a-f0-9-]{36})\/links(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
      if (taskLinks && request.method === 'GET' && !taskLinks[2]) {
        if (!store.get(owner, taskLinks[1])) throw new RequestError(404, 'Task not found');
        reply(response, 200, { links: store.taskChannels(owner, taskLinks[1]) });
        return;
      }
      if (taskLinks?.[2] && request.method === 'DELETE') {
        if (!store.unlinkTaskChannel(owner, taskLinks[1], taskLinks[2])) throw new RequestError(404, 'Task conversation link not found');
        reply(response, 200, { removed: true });
        return;
      }
      if (url.pathname === '/v1/admin/task-links' && request.method === 'POST') {
        const data = await jsonObject(request);
        const id = requiredText(data.taskId, 'task ID', 36);
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new RequestError(400, 'Invalid task ID');
        const link = store.createTaskLink(owner, id, Date.now());
        if (!link) throw new RequestError(404, 'Task not found');
        reply(response, 201, link);
        return;
      }
      if (url.pathname === '/v1/admin/audit-export' && request.method === 'GET') {
        const cursor = store.eventCursor();
        const rawAfter = url.searchParams.get('after') ?? '0';
        const rawThrough = url.searchParams.get('through') ?? String(cursor);
        const after = Number(rawAfter);
        const through = Number(rawThrough);
        if (!/^\d+$/.test(rawAfter) || !/^\d+$/.test(rawThrough) ||
            !Number.isSafeInteger(after) || !Number.isSafeInteger(through) || after > through || through > cursor) {
          throw new RequestError(400, 'Invalid audit export range');
        }
        const page = store.events(owner, after, through);
        reply(response, 200, { version: 1, through, nextAfter: page.length === 100 ? page.at(-1)!.seq : null,
          events: page.map(event => ({ ...event, data: canReadTask(event.taskId) ? JSON.parse(event.data) : {} })),
        });
        return;
      }
      if (url.pathname === '/v1/admin/event-retention' && request.method === 'POST') {
        const data = await jsonObject(request);
        const before = data.before;
        if (typeof before !== 'number' || !Number.isSafeInteger(before) || before <= 0 || before > Date.now()) {
          throw new RequestError(400, 'Invalid progress retention cutoff');
        }
        reply(response, 200, { removed: store.pruneProgressEvents(before) });
        return;
      }
      if (url.pathname === '/v1/admin/metrics' && request.method === 'GET') {
        const channels = [
          ['weixin', config.streamChannels?.weixin, true],
          ['feishu', config.feishu, Boolean(config.readFeishuAttachment)],
          ['lark', config.lark, Boolean(config.readLarkAttachment)],
          ['wecom', config.streamChannels?.wecom, true],
          ['dingtalk', config.streamChannels?.dingtalk, true],
          ['qq', config.qq, true],
        ] as const;
        reply(response, 200, {
          ...ownerMetrics(owner).snapshot(), ...store.metrics(owner, Date.now()),
          channels: channels.map(([id, channel, outbound]) => ({
            id, workspace: channel?.workspace ?? null, inbound: Boolean(channel), outbound: Boolean(channel && outbound),
            ...((channel && 'health' in channel && channel.health) && { health: channel.health() }),
          })),
        });
        return;
      }
      if (url.pathname === '/v1/pairings' && request.method === 'POST') {
        reply(response, 201, store.createPairing(owner, Date.now()));
        return;
      }
      if (url.pathname === '/v1/admin/mobile-pairings' && request.method === 'GET') {
        reply(response, 200, { requests: store.pendingMobilePairings(owner, Date.now()) });
        return;
      }
      const pairingDecision = /^\/v1\/admin\/mobile-pairings\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (pairingDecision && request.method === 'POST') {
        const { approve } = await jsonObject(request);
        if (typeof approve !== 'boolean') throw new RequestError(400, 'Invalid pairing decision');
        if (!store.decideMobilePairing(owner, pairingDecision[1], approve, Date.now())) {
          throw new RequestError(404, 'Pairing request unavailable');
        }
        reply(response, 200, { approved: approve });
        return;
      }
      if (url.pathname === '/v1/admin/mobile-clients' && request.method === 'GET') {
        reply(response, 200, { clients: store.mobileClients(owner) });
        return;
      }
      const revokeMobile = /^\/v1\/admin\/mobile-clients\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (revokeMobile && request.method === 'DELETE') {
        if (!store.revokeMobile(owner, revokeMobile[1])) throw new RequestError(404, 'Mobile client not found');
        reply(response, 200, { revoked: true });
        return;
      }
      if (url.pathname === '/v1/admin/worker-policies') {
        if (request.method === 'GET') {
          reply(response, 200, { policies: store.workspaceWorkerPolicies(owner) });
          return;
        }
        if (request.method === 'PUT') {
          const data = await jsonObject(request);
          const workspace = requiredText(data.workspace, 'workspace', 128);
          const protocols = data.protocols;
          const supported = new Set([...workerCatalog().map(worker => worker.protocol), 'jsonl']);
          if (protocols !== null && (!Array.isArray(protocols) || protocols.length > supported.size ||
              protocols.some(protocol => typeof protocol !== 'string' || !supported.has(protocol)))) {
            throw new RequestError(400, 'Invalid Worker protocols');
          }
          const maxConcurrent = data.maxConcurrent;
          if (maxConcurrent !== undefined && (protocols === null || typeof maxConcurrent !== 'number' ||
              !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 100)) {
            throw new RequestError(400, 'Invalid workspace Worker concurrency limit');
          }
          const runLimitSeconds = data.runLimitSeconds;
          if (runLimitSeconds !== undefined && (protocols === null || typeof runLimitSeconds !== 'number' ||
              !Number.isSafeInteger(runLimitSeconds) || runLimitSeconds < 30 || runLimitSeconds > 600)) {
            throw new RequestError(400, 'Invalid workspace Worker run time limit');
          }
          store.setWorkspaceWorkerPolicy(owner, workspace, protocols === null ? null : [...new Set(protocols)].sort(),
            maxConcurrent, runLimitSeconds);
          store.updateDeviceReadiness(Date.now());
          reply(response, 200, { policies: store.workspaceWorkerPolicies(owner) });
          return;
        }
      }
      if (url.pathname === '/v1/admin/workers' && request.method === 'GET') {
        reply(response, 200, { presets: workerCatalog(), extensionProtocols: ['acp', 'jsonl'] });
        return;
      }
      if (url.pathname === '/v1/admin/devices') {
        if (request.method === 'GET') {
          reply(response, 200, { devices: store.devices(owner) });
          return;
        }
        if (request.method === 'POST') {
          const data = await jsonObject(request);
          const name = requiredText(data.name, 'name', 128);
          const workspace = requiredText(data.workspace, 'workspace', 128);
          reply(response, 201, store.registerDevice(owner, name, workspace));
          return;
        }
      }
      const revoke = /^\/v1\/admin\/devices\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (request.method === 'PATCH' && revoke) {
        const data = await jsonObject(request);
        if (typeof data.paused !== 'boolean') throw new RequestError(400, 'Expected paused to be a boolean');
        if (!store.setDevicePaused(owner, revoke[1], data.paused)) throw new RequestError(404, 'Active device not found');
        reply(response, 200, { paused: data.paused });
        return;
      }
      if (request.method === 'DELETE' && revoke) {
        if (!store.revokeDevice(owner, revoke[1])) throw new RequestError(404, 'Active device not found');
        reply(response, 200, { revoked: true });
        return;
      }
      const shareResult = /^\/v1\/tasks\/([a-f0-9-]{36})\/share-result$/.exec(url.pathname);
      if (shareResult && (request.method === 'GET' || request.method === 'POST')) {
        if (!admin) throw new RequestError(403, 'Administrator required');
        const task = store.get(owner, shareResult[1]);
        if (!task || !store.appEvidence(task.id)) throw new RequestError(404, 'Application-backed task not found');
        if (request.method === 'POST') {
          const data = await jsonObject(request);
          const current = store.get(owner, task.id)!;
          const clientId = requiredText(data.clientId, 'mobile client ID', 36);
          if (typeof data.enabled !== 'boolean') throw new RequestError(400, 'Invalid result sharing option');
          if (data.enabled && (data.expectedVersion !== current.version || current.status !== 'succeeded' || !canReadTask(task.id))) {
            throw new RequestError(409, 'The current task version is not available for sharing');
          }
          if (!store.shareTaskResult(owner, task.id, current.version, clientId, data.enabled)) {
            throw new RequestError(404, 'Paired mobile client not found');
          }
        }
        reply(response, 200, { clients: store.resultGrants(owner, task.id) });
        return;
      }
      const saveTaskMemory = /^\/v1\/tasks\/([a-f0-9-]{36})\/remember-result$/.exec(url.pathname);
      if (saveTaskMemory && request.method === 'POST') {
        if (!admin) throw new RequestError(403, 'Administrator required');
        if (!config.memory) throw new RequestError(503, 'Memory is unavailable');
        const data = await jsonObject(request);
        const task = store.get(owner, saveTaskMemory[1]);
        if (!task) throw new RequestError(404, 'Task not found');
        if (data.expectedVersion !== task.version || task.status !== 'succeeded' || store.appEvidence(task.id) || store.personalEvidence(task.id).length ||
            !task.result?.trim() || task.result.length > 16_000 || /^\/(observe|click) /.test(task.goal)) {
          throw new RequestError(409, 'This task version does not have a result eligible for memory');
        }
        reply(response, 200, { id: config.memory.rememberTaskResult(owner, task.workspace, task.id, task.version, task.result) });
        return;
      }
      const timeline = /^\/v1\/tasks\/([a-f0-9-]{36})\/timeline$/.exec(url.pathname);
      if (request.method === 'GET' && timeline) {
        if (!canReadTask(timeline[1])) throw new RequestError(404, 'Task timeline not found');
        const raw = url.searchParams.get('before');
        const before = raw === null ? undefined : Number(raw);
        if (before !== undefined && (!/^\d+$/.test(raw!) || !Number.isSafeInteger(before) || before < 1)) {
          throw new RequestError(400, 'Invalid timeline cursor');
        }
        const page = store.timeline(owner, timeline[1], before);
        if (!page) throw new RequestError(404, 'Task not found');
        reply(response, 200, page);
        return;
      }
      const diff = /^\/v1\/artifacts\/([a-f0-9-]{36})\/diff$/.exec(url.pathname);
      if (diff && request.method === 'GET') {
        const base = url.searchParams.get('base');
        if (!base || !/^[a-f0-9-]{36}$/.test(base)) throw new RequestError(400, 'Invalid base artifact ID');
        const previous = store.artifact(owner, base);
        const current = store.artifact(owner, diff[1]);
        if (!previous || !current || previous.mime || current.mime || previous.taskId !== current.taskId ||
            !canReadTask(current.taskId, current.version ?? undefined) || !canReadTask(previous.taskId, previous.version ?? undefined)) {
          throw new RequestError(404, 'Comparable artifacts not found');
        }
        const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
        reply(response, 200, { text: artifactDiff(previous.name, decode(previous.content), current.name, decode(current.content)) });
        return;
      }
      const attachmentPath = /^\/v1\/tasks\/([a-f0-9-]{36})\/attachments\/([0-3])$/.exec(url.pathname);
      if (request.method === 'GET' && attachmentPath) {
        if (!canReadTask(attachmentPath[1])) throw new RequestError(404, 'Task attachment not found');
        const attachment = store.taskAttachment(owner, attachmentPath[1], Number(attachmentPath[2]));
        if (!attachment) throw new RequestError(404, 'Task attachment not found');
        reply(response, 200, attachment);
        return;
      }
      const artifactPath = /^\/v1\/artifacts\/([a-f0-9-]{36})(\/image)?$/.exec(url.pathname);
      if (request.method === 'GET' && artifactPath) {
        const file = store.artifact(owner, artifactPath[1]);
        if (!file || !canReadTask(file.taskId, file.version ?? undefined)) throw new RequestError(404, 'Artifact not found');
        if (artifactPath[2]) {
          if (file.mime !== 'image/png') throw new RequestError(404, 'Window image not found');
          reply(response, 200, { png: Buffer.from(file.content).toString('base64') });
          return;
        }
        response.writeHead(200, {
          'Content-Type': file.mime ?? 'text/plain; charset=utf-8',
          'Content-Length': String(file.content.byteLength),
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name.toWellFormed())
            .replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16)),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ETag: '"' + file.sha256 + '"',
        });
        response.end(file.content);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        const snapshot = store.snapshot(owner);
        const protectedTasks = new Set(store.appEvidenceTasks(owner));
        const personalTasks = new Set(store.personalEvidenceTasks(owner));
        const unavailablePersonal = new Set(snapshot.tasks.filter(task => personalTasks.has(task.id) &&
          !config.memory?.resolvePersonalEvidence(owner, task.workspace, store.personalEvidence(task.id))).map(task => task.id));
        const restricted = new Set([...unavailablePersonal, ...[...protectedTasks].filter(taskId => !canReadTask(taskId))]);
        reply(response, 200, { ...snapshot,
          tasks: snapshot.tasks.map(task => ({
            ...task,
            ...(protectedTasks.has(task.id) && { usesAppMemory: true,
              ...(!admin && { goal: protectedTaskLabel }),
              ...(admin && restricted.has(task.id) && { appMemoryUnavailable: true }),
            }),
            ...(personalTasks.has(task.id) && { usesPersonalMemory: true,
              ...(unavailablePersonal.has(task.id) && { personalMemoryUnavailable: true }),
            }),
            ...(restricted.has(task.id) && !canReadTask(task.id, task.version) && { result: null }),
          })),
          artifacts: snapshot.artifacts.filter(item => !restricted.has(String(item.taskId)) ||
            canReadTask(String(item.taskId), typeof item.version === 'number' ? item.version : undefined)),
          criteria: snapshot.criteria.filter(item => admin || !protectedTasks.has(String(item.taskId))),
          workflowSteps: snapshot.workflowSteps.filter(item => admin ||
            (!protectedTasks.has(String(item.taskId)) && !protectedTasks.has(String(item.predecessorId)))),
          attachments: snapshot.attachments.filter(item => !restricted.has(String(item.taskId))),
          progress: snapshot.progress.filter(item => !restricted.has(String(item.taskId))),
          approvals: snapshot.approvals.filter(item => !restricted.has(String(item.taskId))),
          desktopTargets: store.desktopTargets(owner),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/stream') {
        const raw = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
        const cursor = Number(raw);
        if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(cursor)) {
          throw new RequestError(400, 'Invalid event cursor');
        }
        const replayThrough = store.eventCursor();
        const metrics = ownerMetrics(owner);
        if (cursor < store.eventReplayFloor() || cursor > replayThrough) {
          metrics.recordStream('resnapshotRequired');
          throw new RequestError(409, 'Event cursor requires a new snapshot');
        }
        await stream(store, owner, cursor, response, () => admin || store.mobileOwner(mobileToken) === owner,
          url.searchParams.get('once') === '1', canReadTask, replayThrough, metrics);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/workflows') {
        const key = requiredText(request.headers['idempotency-key'], 'Idempotency-Key', 128);
        const data = await jsonObject(request);
        if (!admin && store.mobileOwner(mobileToken) !== owner) throw new RequestError(401, 'Authentication required');
        const workspace = requiredText(data.workspace, 'workspace', 128);
        const steps = workflowSteps(data.steps);
        if (steps.some(step => step.goal.startsWith('/observe ') || step.goal.startsWith('/click '))) {
          throw new RequestError(400, 'Desktop operations require a direct task request');
        }
        const desktopSteps = steps.flatMap(step => step.action ? [step.action] : []);
        if (desktopSteps.length) {
          const targets = store.desktopTargets(owner);
          if (desktopSteps.some(action => !targets.some(target => target.workspace === workspace &&
              target.deviceId === action.deviceId && target.alias === action.alias &&
              (action.kind === 'desktop.observe' || target.controls?.buttons.includes(action.button))))) {
            throw new RequestError(404, 'Workflow desktop target unavailable');
          }
          if (data.appMemory !== undefined) throw new RequestError(400, 'Desktop workflow steps cannot use application memory');
        }
        if (data.appMemory !== undefined && (!admin || steps.some(step => step.goal.startsWith('/preview ')))) {
          throw new RequestError(403, 'Application memory requires an administrator Worker workflow');
        }
        const appEvidence = data.appMemory === undefined ? undefined :
          selectAppEvidence(config.memory, owner, workspace, data.appMemory);
        reply(response, 202, store.createWorkflow(owner, key, workspace, steps, appEvidence, mobile?.id));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/conversation') {
        const key = requiredText(request.headers['idempotency-key'], 'Idempotency-Key', 128);
        const data = await jsonObject(request);
        if (!admin && store.mobileOwner(mobileToken) !== owner) throw new RequestError(401, 'Authentication required');
        if (data.usePersonalMemory !== undefined && typeof data.usePersonalMemory !== 'boolean') {
          throw new RequestError(400, 'Invalid personal memory option');
        }
        const input: RouteRequest = {
          workspace: requiredText(data.workspace, 'workspace', 128),
          text: requiredText(data.text, 'text', 32_000),
          ...(data.usePersonalMemory === true ? { usePersonalMemory: true } : {}),
        };
        const result = await routeConversation({
          owner, caller: mobile?.id ?? 'admin', admin, key, input,
          metrics: ownerMetrics(owner), authorized: () => admin || store.mobileOwner(mobileToken) === owner, canReadTask,
        });
        reply(response, result.status, result.body);
        return;
      }
      const taskCommand = /^\/v1\/tasks\/([a-f0-9-]+)\/commands$/.exec(url.pathname);
      if (request.method === 'POST' && (url.pathname === '/v1/events' || taskCommand)) {
        const key = requiredText(request.headers['idempotency-key'], 'Idempotency-Key', 128);
        const data = await jsonObject(request);
        if (!admin && store.mobileOwner(mobileToken) !== owner) throw new RequestError(401, 'Authentication required');
        if (!taskCommand) {
          const workspace = requiredText(data.workspace, 'workspace', 128);
          const goal = requiredText(data.text, 'text', 32_000);
          const desktopDevice = data.desktopDevice;
          if (desktopDevice !== undefined) {
            if (typeof desktopDevice !== 'string' || !/^[a-f0-9-]{36}$/.test(desktopDevice) ||
                !/^\/(observe|click) /.test(goal)) throw new RequestError(400, 'Invalid desktop target');
            if (!store.ownsDesktopTarget(owner, workspace, desktopDevice)) throw new RequestError(404, 'Desktop target unavailable');
          }
          if (data.usePersonalMemory !== undefined && typeof data.usePersonalMemory !== 'boolean') {
            throw new RequestError(400, 'Invalid task memory option');
          }
          if (data.usePersonalMemory && (!admin || /^\/(observe|click|preview) /.test(goal))) {
            throw new RequestError(403, 'Personal memory is only available for administrator Worker tasks');
          }
          if (data.usePersonalMemory && !config.memory) throw new RequestError(503, 'Memory is unavailable');
          const memoryInputs = data.usePersonalMemory ? config.memory!.personalContext(owner, workspace, goal) : undefined;
          let appEvidence;
          if (data.appMemory !== undefined) {
            if (!admin || desktopDevice || /^\/(observe|click|preview) /.test(goal)) {
              throw new RequestError(403, 'Application memory is only available for administrator Worker tasks');
            }
            appEvidence = selectAppEvidence(config.memory, owner, workspace, data.appMemory);
          }
          if (data.attachments !== undefined && /^\/(observe|click|preview) /.test(goal)) {
            throw new RequestError(400, 'Attachments require a Worker task');
          }
          const attachments = data.attachments === undefined ? undefined : textAttachments(data.attachments);
          let copiedFromTask;
          if (data.copiedFromTask !== undefined) {
            if (!admin) throw new RequestError(403, 'Administrator required');
            copiedFromTask = requiredText(data.copiedFromTask, 'source task ID', 36);
            if (!/^[a-f0-9-]{36}$/.test(copiedFromTask)) throw new RequestError(400, 'Invalid source task ID');
            if (store.get(owner, copiedFromTask)?.workspace !== workspace) {
              throw new RequestError(404, 'Source task not found in this workspace');
            }
            if (store.appEvidence(copiedFromTask) && !appEvidence) {
              throw new RequestError(400, 'Select application memory for the new task');
            }
          }
          const source = mobile ? 'mobile-api:' + mobile.id : 'desktop-api';
          const task = store.create(owner, source, key, workspace, goal, desktopDevice, memoryInputs,
            appEvidence, attachments, copiedFromTask);
          ownerMetrics(owner).observe('event', performance.now() - started);
          reply(response, 202, taskResponse(task));
          return;
        }
        const taskId = taskCommand[1];
        const current = store.get(owner, taskId);
        if (!current) throw new RequestError(404, 'Task not found');
        const version = data.expectedVersion;
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
          throw new RequestError(400, 'Invalid expectedVersion');
        }
        const action = data.action;
        let command: Parameters<TaskStore['command']>[3];
        if (action === 'append') command = { action, text: requiredText(data.text, 'text', 32_000) };
        else if (action === 'cancel' || action === 'pause' || action === 'resume' || action === 'retry' || action === 'accept_result' || action === 'reject_result') command = { action };
        else if (action === 'approve' || action === 'deny') {
          command = { action, approvalId: requiredText(data.approvalId, 'approval ID', 36) };
        } else throw new RequestError(400, 'Invalid action');
        if (['approve', 'accept_result', 'append', 'resume', 'retry'].includes(command.action)) {
          if (!workerMemoryAvailable(store, config.memory, owner, current.workspace, taskId)) {
            flushStopNotifications();
            throw new RequestError(409, 'Task memory access changed');
          }
        }
        const result = store.command(owner, taskId, version, command, key, mobile?.id);
        if (result) {
          if (action === 'pause' || action === 'cancel' || action === 'append') notifyStop(owner, taskId);
          reply(response, 200, taskResponse(result));
        } else {
          const task = store.get(owner, taskId);
          reply(response, 409, { error: 'Task state changed or command unavailable',
            task: task && taskResponse(task) });
        }
        return;
      }
      if (config.memory && await handleMemory(request, response, url, owner, config.memory, config.documents, config.answerMemory)) {
        if (request.method !== 'GET') flushStopNotifications();
        return;
      }
      throw new RequestError(404, 'Route not found');
    } catch (error) {
      if (response.headersSent) {
        response.end();
      } else if (error instanceof RequestError || error instanceof ConversationError) {
        reply(response, error.status, { error: error.message });
      } else if (error instanceof InvalidWorkflow) {
        reply(response, 400, { error: error.message });
      } else if (error instanceof IdempotencyConflict) {
        reply(response, 409, { error: error.message });
      } else {
        reply(response, 500, { error: 'Internal server error' });
      }
    }
  });

  const socketServer = new WebSocketServer({ noServer: true, maxPayload: maxDeviceFinishBytes, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const auth = request.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const device = store.deviceForToken(token);
    if (request.url !== '/v1/devices/connect' || !device) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    socketServer.handleUpgrade(request, socket, head, connection => {
      connection.on('error', () => connection.terminate());
      if (request.headers['x-blazar-device-stop-push'] === '1') {
        const peers = stopSubscribers.get(device.id) ?? new Set<WebSocket>();
        stopSubscribers.set(device.id, peers);
        peers.add(connection);
        connection.once('close', () => {
          peers.delete(connection);
          if (!peers.size) stopSubscribers.delete(device.id);
        });
        for (const row of store.deviceStopTargets(device.id)) {
          connection.send(JSON.stringify({ type: 'run.stop', runId: row.id }));
        }
      }
      connection.on('message', (raw, binary) => {
        let id: number | undefined;
        try {
          const frame = binary ? null : JSON.parse(raw.toString());
          if (!frame || !Number.isSafeInteger(frame.id) || frame.id < 1 ||
              typeof frame.path !== 'string' || frame.path.length > 128 || !frame.body ||
              typeof frame.body !== 'object' || Array.isArray(frame.body)) {
            connection.close(1003, 'Invalid frame');
            return;
          }
          id = frame.id;
          const limit = frame.path.endsWith('/finish') ? maxDeviceFinishBytes :
            frame.path === 'claim' ? maxDeviceClaimBytes : 65_536;
          if (!Array.isArray(raw) && raw.byteLength > limit) {
            throw new RequestError(413, 'Request too large');
          }
          if (connection.bufferedAmount > 256_000) {
            connection.close(1008, 'Slow device connection');
            return;
          }
          const result = deviceOperation(store, token, '/v1/device/' + frame.path, frame.body, expireRuns, config.memory);
          connection.send(JSON.stringify({ id, ...result }));
        } catch (error) {
          if (id === undefined) {
            connection.close(1003, 'Invalid frame');
            return;
          }
          const status = error instanceof RequestError ? error.status : error instanceof IdempotencyConflict ? 409 : 500;
          connection.send(JSON.stringify({ id, status, body: { error: status === 500
            ? 'Internal server error' : (error as Error).message } }));
          if (status === 401) connection.close(1008, 'Device revoked');
        }
      });
    });
  });
  let socketsClosed = false;
  const closeDeviceSockets = () => {
    if (socketsClosed) return;
    socketsClosed = true;
    for (const connection of socketServer.clients) connection.terminate();
    socketServer.close();
  };
  server.once('close', closeDeviceSockets);
  return Object.assign(server, { closeDeviceSockets, flushStopNotifications, expireRuns });
}
