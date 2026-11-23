import type { ConfiguredApplicationWrite } from '../../../packages/apps/config.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { documentAppCatalog, documentCapabilityState, isDocumentCapability, type DocumentConnector } from '../../../packages/apps/documents.ts';
import { invokeDocumentCapability } from '../application/document-sync.ts';
import { answerFromDocuments } from '../application/document-answer.ts';
import type { ModelAdmission } from '../application/model-admission.ts';
import { answerFromMemory } from '../application/memory-answer.ts';
import { requestMemoryDraft } from '../application/memory-draft.ts';
import type { MemoryAnswer, MemoryDraft } from '../harness.ts';
import type { MemoryStore, MemoryReference, ResourceRef } from '../memory.ts';
import { RequestError, requiredText } from '../protocol/request.ts';
import { jsonObject, reply } from './json.ts';

const legacyDocumentCapabilities = new Map([
  ['import-document', 'document.import'],
  ['test-document', 'document.test'],
  ['refresh-documents', 'document.refresh'],
]);

export async function handleMemory(
  request: IncomingMessage, response: ServerResponse, url: URL, owner: string, store: MemoryStore, admission: ModelAdmission,
  documents?: readonly DocumentConnector[], answerMemory?: MemoryAnswer, draftMemory?: MemoryDraft, applicationWrites: readonly ConfiguredApplicationWrite[] = [],
  completeWikiReminder?: (pageId: string, revisionId: string) => void,
): Promise<boolean> {
  const { pathname, searchParams } = url;
  const method = request.method;
  const reserve = async (signal?: AbortSignal) => {
    const release = await admission.acquire(JSON.stringify([owner, 'admin']), signal);
    if (signal?.aborted) {
      release?.();
      signal.throwIfAborted();
    }
    if (!release) throw new RequestError(429, 'Blazar model is busy. Please retry.');
    return release;
  };
  const readerFor = (connection: { app: string; account: string }) =>
    documents?.find(connector => connector.app === connection.app && connector.account === connection.account);
  if (pathname === '/v1/app-connections') {
    if (method === 'GET') {
      reply(response, 200, {
        definitions: documentAppCatalog(documents ?? []),
        documentSync: store.documentSyncSettings(owner),
        connections: store.connections(owner).map(connection => {
          const reader = readerFor(connection);
          const writes = connection.active
            ? applicationWrites.filter(item => item.app === connection.app && item.account === connection.account) : [];
          return {
            ...connection,
            canImportDocument: Boolean(connection.active && reader),
            documentAliases: connection.active ? reader?.documentAliases : undefined,
            capabilities: documentCapabilityState(connection, reader),
            writeCapabilities: writes.map(item => item.capability),
            ...(writes.some(item => item.contract) && { writeCapabilityDetails: writes.flatMap(item => item.contract
              ? [{ id: item.capability, ...item.contract.definition }] : []) }),
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

  const capabilityPath = /^\/v1\/app-connections\/([a-f0-9-]{36})\/capabilities\/([a-z0-9.-]{1,128})$/.exec(pathname);
  const legacyDocumentPath = /^\/v1\/app-connections\/([a-f0-9-]{36})\/(import-document|test-document|refresh-documents)$/.exec(pathname);
  const invocation = capabilityPath ?? legacyDocumentPath;
  if (invocation && method === 'POST') {
    const [, connectionId, requested] = invocation;
    const capability = legacyDocumentPath ? legacyDocumentCapabilities.get(requested) ?? requested : requested;
    if (!isDocumentCapability(capability)) throw new RequestError(404, 'Application capability not found');
    reply(response, 200, await invokeDocumentCapability(store, owner, connectionId, documents ?? [], capability, await jsonObject(request)));
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

  if (pathname === '/v1/wiki' && method === 'GET') {
    const workspace = requiredText(searchParams.get('workspace'), 'workspace', 128);
    const query = searchParams.has('q') ? requiredText(searchParams.get('q'), 'query', 256) : '';
    reply(response, 200, { pages: store.wikiPages(owner, workspace, query) });
    return true;
  }

  if (pathname === '/v1/wiki' && method === 'POST') {
    const data = await jsonObject(request);
    const workspace = requiredText(data.workspace, 'workspace', 128);
    const title = requiredText(data.title, 'title', 160);
    const body = requiredText(data.body, 'body', 16_000);
    const references = wikiReferences(data.sources);
    const replaces = data.replaces === undefined ? undefined : requiredText(data.replaces, 'previous Wiki page', 36);
    const id = store.saveWikiPage(owner, workspace, title, body, references, replaces);
    if (!id) throw new RequestError(409, 'A Wiki source changed or is no longer available');
    if (replaces && replaces !== id) completeWikiReminder?.(replaces, id);
    reply(response, 201, { id });
    return true;
  }

  const wikiRevision = /^\/v1\/wiki\/([a-f0-9-]{36})\/revision$/.exec(pathname);
  if (wikiRevision && method === 'GET') {
    const revision = store.wikiRevision(owner, wikiRevision[1]);
    if (!revision) throw new RequestError(404, 'Wiki page unavailable');
    reply(response, 200, revision);
    return true;
  }

  const wikiWatch = /^\/v1\/wiki\/([a-f0-9-]{36})\/watch$/.exec(pathname);
  if (wikiWatch && method === 'PUT') {
    const { enabled } = await jsonObject(request);
    if (typeof enabled !== 'boolean') throw new RequestError(400, 'Invalid Wiki watch setting');
    if (!store.watchWikiPage(owner, wikiWatch[1], enabled)) throw new RequestError(404, 'Wiki page unavailable');
    reply(response, 200, { enabled });
    return true;
  }

  if (pathname === '/v1/wiki/draft' && method === 'POST') {
    if (!answerMemory) throw new RequestError(503, 'Blazar has no Router model configured');
    const data = await jsonObject(request);
    const workspace = requiredText(data.workspace, 'workspace', 128);
    const title = requiredText(data.title, 'title', 160);
    const references = wikiReferences(data.sources);
    await replyWhileConnected(response, async signal => {
      const evidence = store.resolveAppEvidence(owner, workspace, references);
      if (!evidence) throw new RequestError(409, 'A Wiki source changed or is no longer available');
      const checkSources = () => {
        signal.throwIfAborted();
        const current = store.resolveAppEvidence(owner, workspace, references);
        if (!current || current.some((item, index) => item.scopeVersion !== evidence[index].scopeVersion)) {
          throw new RequestError(409, 'A Wiki source changed while drafting');
        }
      };
      const release = await reserve(signal);
      let body: string;
      try {
        checkSources();
        body = (await answerMemory(`Write a concise Markdown Wiki page about this title: ${title}`,
          evidence, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))).trim();
        if (!body || body.length > 8_000) throw new Error('Invalid Wiki draft');
      } catch {
        checkSources();
        throw new RequestError(503, 'Blazar could not draft the Wiki page. Please retry.');
      } finally {
        release();
      }
      checkSources();
      return { body };
    });
    return true;
  }

  if (pathname === '/v1/memory/draft' && method === 'POST') {
    if (!draftMemory) throw new RequestError(503, 'Blazar has no Router model configured');
    const data = await jsonObject(request);
    const workspace = requiredText(data.workspace, 'workspace', 128);
    const id = requiredText(data.id, 'source memory ID', 36);
    const version = data.version;
    if (!/^[a-f0-9-]{36}$/.test(id) || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      throw new RequestError(400, 'Invalid memory evidence');
    }
    await replyWhileConnected(response, signal => requestMemoryDraft(store, draftMemory, owner, workspace, { id, version }, signal, reserve));
    return true;
  }
  if (pathname === '/v1/memory/answer' && method === 'POST') {
    const data = await jsonObject(request);
    const workspace = requiredText(data.workspace, 'workspace', 128);
    const question = requiredText(data.question, 'question', 4_000);
    await replyWhileConnected(response, signal => data.documents !== undefined
      ? answerFromDocuments(store, documents ?? [], answerMemory, owner, workspace, question, data.documents, signal, reserve)
      : answerFromMemory(store, answerMemory, owner, workspace, question, data, signal, reserve));
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
    if (data.derivedFrom !== undefined) {
      const ref = data.derivedFrom as { id?: unknown; version?: unknown } | null;
      if (!ref || typeof ref.id !== 'string' || !/^[a-f0-9-]{36}$/.test(ref.id) ||
          typeof ref.version !== 'number' || !Number.isSafeInteger(ref.version) || ref.version < 1 ||
          data.source !== undefined || data.expires !== undefined) {
        throw new RequestError(400, 'Invalid memory evidence');
      }
      const id = store.rememberFromEvidence(owner, workspace, ref.id, ref.version, body);
      if (!id) throw new RequestError(409, 'Source memory changed or is no longer available');
      reply(response, 201, { id });
      return true;
    }
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


function wikiReferences(value: unknown): MemoryReference[] {
  if (!Array.isArray(value) || !value.length || value.length > 6 ||
      value.some(ref => !ref || typeof ref.id !== 'string' || !/^[a-f0-9-]{36}$/.test(ref.id) ||
        !Number.isSafeInteger(ref.version) || ref.version < 1) ||
      new Set(value.map(ref => ref.id)).size !== value.length) {
    throw new RequestError(400, 'Choose between one and six distinct versioned Wiki sources');
  }
  return value.map(({ id, version }) => ({ id, version }));
}

async function replyWhileConnected(response: ServerResponse, operation: (signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  response.once('close', disconnect);
  if (response.destroyed) disconnect();
  try {
    controller.signal.throwIfAborted();
    const result = await operation(controller.signal);
    if (!controller.signal.aborted) reply(response, 200, result);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    response.removeListener('close', disconnect);
  }
}
