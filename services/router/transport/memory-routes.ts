import type { IncomingMessage, ServerResponse } from 'node:http';
import { documentAppCatalog, documentCapabilityState, type DocumentConnector } from '../../../packages/apps/documents.ts';
import { accessDocument, refreshDocumentPage } from '../application/document-sync.ts';
import type { MemoryAnswer } from '../harness.ts';
import type { MemoryStore, ResourceRef } from '../memory.ts';
import { RequestError, requiredText } from '../protocol/request.ts';
import { jsonObject, reply } from './json.ts';

export async function handleMemory(
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
