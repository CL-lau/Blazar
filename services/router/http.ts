import type { WorkerConfiguration } from '../../packages/protocol/task.ts';
import { artifactDiff } from './artifact-diff.ts';
import { workerCatalog } from '../../packages/workers/registry.ts';
import { performance } from 'node:perf_hooks';
import { RouterMetrics } from './metrics.ts';
import { DocumentUnavailable, type DocumentConnector } from '../../packages/apps/documents.ts';
import { WebSocket, WebSocketServer } from 'ws';
import { createQQHandler, qqChannel, type QQConfig } from '../../packages/channels/qq.ts';
import { feishuChannel, parseFeishu, type FeishuConfig } from '../../packages/channels/feishu.ts';
import { InvalidWorkflow, workflowSteps } from './workflow.ts';
import type { MemoryAnswer, RouteRequest, RouterHarness } from './harness.ts';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { MemoryStore, ResourceRef } from './memory.ts';
import { IdempotencyConflict, TaskStore } from './store.ts';

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

async function jsonBody(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new RequestError(415, 'Expected application/json');
  }
  let size = 0;
  const buffers: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 65_536) {
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

async function jsonObject(request: IncomingMessage) {
  return (await jsonBody(request)).body;
}

function reply(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function stream(store: TaskStore, owner: string, cursor: number, response: ServerResponse, authorized: () => boolean, once: boolean) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  response.flushHeaders();
  const controller = new AbortController();
  response.once('close', () => controller.abort());
  const deadline = Date.now() + 25_000;
  try {
    while (!controller.signal.aborted && Date.now() < deadline && authorized()) {
      const events = store.events(owner, cursor);
      for (const event of events) {
        const frame = JSON.stringify({ ...event, data: JSON.parse(event.data) });
        if (!response.write(`id: ${event.seq}\nevent: task\ndata: ${frame}\n\n`)) return;
        if (once) return;
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

async function handleMemory(
  request: IncomingMessage, response: ServerResponse, url: URL, owner: string, store: MemoryStore, documents?: readonly DocumentConnector[], answerMemory?: MemoryAnswer,
): Promise<boolean> {
  const { pathname, searchParams } = url;
  const method = request.method;
  const readerFor = (connection: { app: string; account: string }) =>
    documents?.find(connector => connector.app === connection.app && connector.account === connection.account);
  if (pathname === '/v1/app-connections') {
    if (method === 'GET') {
      reply(response, 200, { connections: store.connections(owner).map(connection => ({
        ...connection, canImportDocument: Boolean(connection.active && readerFor(connection)),
      })) });
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

  const importPath = /^\/v1\/app-connections\/([a-f0-9-]{36})\/(import-document|test-document)$/.exec(pathname);
  if (importPath && method === 'POST') {
    const data = await jsonObject(request);
    const workspace = requiredText(data.workspace, 'workspace', 128);
    const document = requiredText(data.document, 'document ID', 128);
    const connection = store.connection(owner, importPath[1], workspace);
    if (!connection) throw new RequestError(404, 'Active connection not found');
    const reader = readerFor(connection);
    if (!reader) {
      throw new RequestError(409, 'No document reader is configured for this connection');
    }
    if (store.resourceRevoked(importPath[1], document)) throw new RequestError(409, 'Document access was revoked');
    if (!reader.accepts(document)) throw new RequestError(400, 'Invalid document reference');
    let content;
    try {
      content = await reader.read(document, AbortSignal.timeout(10_000));
    } catch (error) {
      throw new RequestError(502, error instanceof DocumentUnavailable ? error.message : 'Document read failed');
    }
    if (importPath[2] === 'test-document') {
      if (!store.connection(owner, importPath[1], workspace) || store.resourceRevoked(importPath[1], document)) {
        throw new RequestError(409, 'Source access changed during the test');
      }
      reply(response, 200, { readable: true });
      return true;
    }
    const id = store.importDocument(owner, workspace, content.text, {
      connection: importPath[1], resource: document, revision: content.revision,
    });
    if (!id) throw new RequestError(409, 'Source access changed during import');
    reply(response, 200, { id, revision: content.revision });
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

function deviceOperation(store: TaskStore, bearer: string, pathname: string, data: Record<string, unknown>) {
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
    store.recordDeviceWorker(device.id, worker);
    store.recordDeviceActivity(device.id, now, data.capability, platform);
    store.expire(now);
    const assignment = store.claim(device.owner, device.workspace, device.id, now, leaseMs,
      data.capability === 'document.preview' ? '/preview ' : data.capability === 'computer.observe' ? '/observe ' : '',
      data.capability === 'agent.acp' ? '/preview ' : '', key, worker);
    store.clearInterruption(device.id);
    return { status: 200, body: { assignment: assignment ?? null, ...(assignment && { leaseRemainingMs: Math.max(0, assignment.run.expires - Date.now()) }) } };
  }
  const run = /^\/v1\/device\/runs\/([a-f0-9-]{36})\/(renew|finish|stopped|request-approval|approval|consume-approval|progress|input-artifact|steer)$/.exec(pathname);
  if (!run) throw new RequestError(404, 'Route not found');
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
  if (data.status !== 'succeeded' && data.status !== 'failed') {
    throw new RequestError(400, 'Invalid outcome status');
  }
  let artifact: { name: string; text: string } | undefined;
  if (data.artifact !== undefined) {
    if (data.status !== 'succeeded' || !data.artifact || typeof data.artifact !== 'object' || Array.isArray(data.artifact)) {
      throw new RequestError(400, 'Invalid artifact');
    }
    const file = data.artifact as Record<string, unknown>;
    const name = requiredText(file.name, 'artifact name', 128);
    if (typeof file.text !== 'string' || Buffer.byteLength(file.text) > 32_000) {
      throw new RequestError(400, 'Invalid artifact content');
    }
    artifact = { name, text: file.text };
  }
  const accepted = store.finish(run[1], device.id, now, {
    status: data.status,
    result: requiredText(data.result, 'result', 32_000),
    artifact,
  });
  return { status: accepted ? 200 : 409, body: { accepted } };
}

export function routerServer(store: TaskStore, config: { owner: string; token: string; memory?: MemoryStore; harness?: RouterHarness; feishu?: FeishuConfig; qq?: QQConfig; documents?: readonly DocumentConnector[]; answerMemory?: MemoryAnswer; pushEnabled?: boolean }) {
  const metrics = new RouterMetrics();
  const stopSubscribers = new Map<string, Set<WebSocket>>();
  function sendStop(device: string, runId: string) {
    for (const peer of stopSubscribers.get(device) ?? []) {
      if (peer.readyState === WebSocket.OPEN && peer.bufferedAmount < 256_000) {
        peer.send(JSON.stringify({ type: 'run.stop', runId }));
      }
    }
  }
  function notifyStop(owner: string, taskId: string) {
    const target = store.stopTarget(owner, taskId);
    if (target) sendStop(target.device, target.runId);
  }
  function flushStopNotifications() {
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
            metrics.observe('qq', performance.now() - started);
          }
          reply(response, 200, { op: 12 });
        }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/channels/feishu/events' && config.feishu) {
        const event = parseFeishu(await jsonObject(request), config.feishu);
        if (event.kind === 'unauthorized') throw new RequestError(401, 'Channel authentication required');
        if (event.kind === 'challenge') {
          reply(response, 200, { challenge: event.value });
          return;
        }
        if (event.kind === 'message') {
          const channel = feishuChannel(config.feishu);
          store.receiveChannelMessage(config.owner, channel, config.feishu.workspace, event);
          flushStopNotifications();
          metrics.observe('feishu', performance.now() - started);
        }
        reply(response, 200, {});
        return;
      }
      if (url.pathname.startsWith('/v1/device/')) {
        if (request.method !== 'POST') throw new RequestError(405, 'Expected POST');
        if (!auth.startsWith('Bearer ')) throw new RequestError(401, 'Device authentication required');
        const result = deviceOperation(store, auth.slice(7), url.pathname, await jsonObject(request));
        reply(response, result.status, result.body);
        return;
      }
      if (url.pathname === '/v1/pairings/redeem' && request.method === 'POST') {
        const data = await jsonObject(request);
        const code = requiredText(data.code, 'code', 32);
        const name = requiredText(data.name, 'name', 128);
        const registration = store.redeemPairing(code, name, Date.now());
        if (!registration) throw new RequestError(404, 'Pairing code is invalid or expired');
        reply(response, 201, registration);
        return;
      }
      const supplied = Buffer.from(auth);
      const publicGateway = request.headers['x-blazar-public-gateway'] === '1';
      const admin = !publicGateway && supplied.length === expected.length && timingSafeEqual(supplied, expected);
      const mobileToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const owner = admin ? config.owner : store.mobileOwner(mobileToken);
      if (!owner) throw new RequestError(401, 'Authentication required');
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
      if (url.pathname === '/v1/admin/metrics' && request.method === 'GET') {
        reply(response, 200, { ...metrics.snapshot(), ...store.metrics(owner, Date.now()) });
        return;
      }
      if (url.pathname === '/v1/pairings' && request.method === 'POST') {
        reply(response, 201, store.createPairing(owner, Date.now()));
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
      const timeline = /^\/v1\/tasks\/([a-f0-9-]{36})\/timeline$/.exec(url.pathname);
      if (request.method === 'GET' && timeline) {
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
        if (!previous || !current || previous.taskId !== current.taskId) {
          throw new RequestError(404, 'Comparable artifacts not found');
        }
        const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
        reply(response, 200, { text: artifactDiff(previous.name, decode(previous.content), current.name, decode(current.content)) });
        return;
      }
      const artifactPath = /^\/v1\/artifacts\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (request.method === 'GET' && artifactPath) {
        const file = store.artifact(owner, artifactPath[1]);
        if (!file) throw new RequestError(404, 'Artifact not found');
        response.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
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
        reply(response, 200, store.snapshot(owner));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/stream') {
        const raw = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
        const cursor = Number(raw);
        if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(cursor)) {
          throw new RequestError(400, 'Invalid event cursor');
        }
        if (cursor > store.eventCursor()) throw new RequestError(409, 'Event cursor requires a new snapshot');
        await stream(store, owner, cursor, response, () => admin || store.mobileOwner(mobileToken) === owner,
          url.searchParams.get('once') === '1');
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
        reply(response, 202, store.createWorkflow(owner, key, workspace, steps));
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
        let decision = store.routingDecision(owner, key, input);
        if (decision) metrics.route('replayed');
        else {
          if (input.text.startsWith('/preview ') || input.text.startsWith('/observe ') || input.text.startsWith('/click ')) {
            decision = { kind: 'create_task' };
            metrics.route('deterministic');
          }
          else if (!config.harness) throw new RequestError(503, 'Blazar has no Router model configured');
          else {
            const recall = () => input.usePersonalMemory
              ? config.memory?.personalContext(owner, input.workspace, input.text) ?? [] : [];
            const evidence = recall();
            const modelStarted = performance.now();
            metrics.route('model');
            try {
              decision = await config.harness({
                ...input, recent: store.recentConversation(owner, input.workspace),
                ...(evidence.length ? { personalMemory: evidence.map(item => item.body) } : {}),
              }, AbortSignal.timeout(15_000));
            } catch {
              metrics.route('modelErrors');
              throw new RequestError(503, 'Blazar could not make a routing decision. Please retry.');
            } finally {
              metrics.observe('model', performance.now() - modelStarted);
            }
            if (evidence.length) {
              const current = recall();
              if (evidence.some(item => !current.some(note => note.id === item.id && note.version === item.version))) {
                throw new RequestError(409, 'Personal memory changed while routing. Please retry.');
              }
            }
          }
          if (!admin && store.mobileOwner(mobileToken) !== owner) throw new RequestError(401, 'Authentication required');
          decision = store.routingDecision(owner, key, input, decision)!;
        }
        if (decision.kind === 'create_task') {
          const goal = decision.goal ?? input.text;
          if ((goal.startsWith('/observe ') || goal.startsWith('/click ')) && goal !== input.text) {
            throw new RequestError(400, 'Application observation requires an explicit command');
          }
          const task = store.create(owner, 'conversation', key, input.workspace, goal);
          reply(response, 202, { kind: decision.kind, task });
        } else {
          reply(response, 200, decision);
        }
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
          const task = store.create(owner, 'desktop-api', key, workspace, goal);
          metrics.observe('event', performance.now() - started);
          reply(response, 202, task);
          return;
        }
        const taskId = taskCommand[1];
        if (!store.get(owner, taskId)) throw new RequestError(404, 'Task not found');
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
        const result = store.command(owner, taskId, version, command, key);
        if (result) {
          if (action === 'pause' || action === 'cancel' || action === 'append') notifyStop(owner, taskId);
          reply(response, 200, result);
        } else reply(response, 409, { error: 'Task state changed or command unavailable', task: store.get(owner, taskId) });
        return;
      }
      if (config.memory && await handleMemory(request, response, url, owner, config.memory, config.documents, config.answerMemory)) return;
      throw new RequestError(404, 'Route not found');
    } catch (error) {
      if (response.headersSent) {
        response.end();
      } else if (error instanceof RequestError) {
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

  const socketServer = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
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
          if (connection.bufferedAmount > 256_000) {
            connection.close(1008, 'Slow device connection');
            return;
          }
          const result = deviceOperation(store, token, '/v1/device/' + frame.path, frame.body);
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
  return Object.assign(server, { closeDeviceSockets, flushStopNotifications });
}
