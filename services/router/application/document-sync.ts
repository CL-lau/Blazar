import { DocumentAccessDenied, DocumentUnavailable, type DocumentConnector, type DocumentCapabilityId } from '../../../packages/apps/documents.ts';
import type { MemoryStore } from '../memory.ts';
import { RequestError, requiredText } from '../protocol/request.ts';

type DocumentMemory = Pick<MemoryStore, 'connection' | 'documentSyncActive' | 'documentsToRefresh' |
  'finishAppUsage' | 'finishDocumentSync' | 'importDocument' | 'leaseDocumentSync' |
  'recall' | 'recordDocumentAccess' | 'resourceRevoked' | 'startAppUsage' | 'hasNewerDocumentDenial'>;

export async function accessDocument(store: DocumentMemory, owner: string, workspace: string, connection: string,
                              reader: DocumentConnector, document: string, operation: 'test' | 'import' | 'refresh' | 'read',
                              signal?: AbortSignal, permitted = () => true) {
  const source = store.connection(owner, connection, workspace);
  if (!source || !permitted()) throw new RequestError(409, 'Source access changed before the document read');
  const canUseResult = () => permitted() &&
    store.connection(owner, connection, workspace)?.scopeVersion === source.scopeVersion &&
    !store.resourceRevoked(connection, document);
  if (store.resourceRevoked(connection, document)) throw new RequestError(409, 'Document access was revoked');
  if (!reader.accepts(document)) throw new RequestError(400, 'Invalid document reference');
  const usageId = store.startAppUsage(connection, workspace, operation);
  let content;
  try {
    const timeout = AbortSignal.timeout(10_000);
    content = await reader.read(document, signal ? AbortSignal.any([timeout, signal]) : timeout);
  } catch (error) {
    if (!canUseResult()) {
      store.finishAppUsage(usageId, 'access_changed');
      throw new RequestError(409, 'Source access changed during the document read');
    }
    if (error instanceof DocumentAccessDenied) store.recordDocumentAccess(connection, document, usageId, false);
    store.finishAppUsage(usageId, error instanceof DocumentAccessDenied ? 'access_denied' : 'failed');
    throw new RequestError(502, error instanceof DocumentUnavailable ? error.message : 'Document read failed');
  }
  if (!canUseResult()) {
    store.finishAppUsage(usageId, 'access_changed');
    throw new RequestError(409, 'Source access changed during the document read');
  }
  if (operation === 'test') {
    store.finishAppUsage(usageId, 'succeeded', content.backend);
    return { readable: true };
  }
  if (operation === 'read') {
    if (store.hasNewerDocumentDenial(connection, document, usageId)) {
      store.finishAppUsage(usageId, 'access_changed');
      throw new RequestError(409, 'Source access changed during the document read');
    }
    store.finishAppUsage(usageId, 'succeeded', content.backend);
    return { connection, resource: document, revision: content.revision,
      ...(content.backend && { backend: content.backend }),
      text: content.text.slice(0, 4_000).toWellFormed(), truncated: content.text.length > 4_000 };
  }
  const id = store.importDocument(owner, workspace, content.text, {
    connection, resource: document, revision: content.revision,
  }, usageId, content.backend);
  store.finishAppUsage(usageId, id ? 'succeeded' : 'access_changed', id ? content.backend : undefined);
  if (!id) throw new RequestError(409, 'Source access changed during import');
  return { id, revision: content.revision };
}

export async function refreshDocumentPage(store: DocumentMemory, owner: string, workspace: string, connection: string,
                                   reader: DocumentConnector, cursor: string, signal?: AbortSignal, permitted?: () => boolean) {
  const documents = store.documentsToRefresh(owner, workspace, connection, cursor);
  const page = documents.slice(0, 8);
  const results = await Promise.allSettled(page.map(document =>
    accessDocument(store, owner, workspace, connection, reader, document, 'refresh', signal, permitted)));
  const refreshed = results.filter(result => result.status === 'fulfilled').length;
  return { refreshed, unavailable: results.length - refreshed, after: documents.length > page.length ? page.at(-1)! : null };
}

export async function invokeDocumentCapability(store: DocumentMemory, owner: string, connectionId: string,
                                               readers: readonly DocumentConnector[], capability: DocumentCapabilityId,
                                               input: Record<string, unknown>) {
  const workspace = requiredText(input.workspace, 'workspace', 128);
  const connection = store.connection(owner, connectionId, workspace);
  if (!connection) throw new RequestError(404, 'Active connection not found');
  const reader = readers.find(candidate => candidate.app === connection.app && candidate.account === connection.account);
  if (!reader) throw new RequestError(409, 'No document reader is configured for this connection');
  if (capability === 'connection.health') {
    if (!reader.health) throw new RequestError(404, 'Connection health checks are unavailable');
    const usage = store.startAppUsage(connectionId, workspace, 'health');
    let status: 'succeeded' | 'access_denied' | 'failed' = 'succeeded';
    try {
      await reader.health(AbortSignal.timeout(10_000));
    } catch (error) {
      status = error instanceof DocumentAccessDenied ? 'access_denied' : 'failed';
    }
    if (store.connection(owner, connectionId, workspace)?.scopeVersion !== connection.scopeVersion) {
      store.finishAppUsage(usage, 'access_changed');
      throw new RequestError(409, 'Source access changed during the connection check');
    }
    store.finishAppUsage(usage, status);
    return { status };
  }
  if (capability === 'document.discover') {
    if (!reader.discover) throw new RequestError(404, 'Document discovery is unavailable for this connection');
    const usage = store.startAppUsage(connectionId, workspace, 'discover');
    const checkSource = () => {
      if (store.connection(owner, connectionId, workspace)?.scopeVersion !== connection.scopeVersion) {
        store.finishAppUsage(usage, 'access_changed');
        throw new RequestError(409, 'Source access changed during discovery');
      }
    };
    let result: Awaited<ReturnType<NonNullable<DocumentConnector['discover']>>>;
    try {
      result = await reader.discover(AbortSignal.timeout(10_000));
    } catch (error) {
      checkSource();
      store.finishAppUsage(usage, error instanceof DocumentAccessDenied ? 'access_denied' : 'failed');
      throw new RequestError(502, error instanceof DocumentUnavailable ? error.message : 'Document discovery failed');
    }
    checkSource();
    const aliases = result.aliases.filter(alias => reader.accepts(alias) && !store.resourceRevoked(connectionId, alias));
    store.finishAppUsage(usage, 'succeeded');
    return { aliases, complete: result.complete };
  }
  if (capability === 'document.search') {
    const query = requiredText(input.query, 'search terms', 256);
    const usage = store.startAppUsage(connectionId, workspace, 'search');
    try {
      const items = store.recall(owner, workspace, query, [connectionId], false, false, { documentsOnly: true })
        .map(({ id, resource, revision, body }) => ({ id, resource, revision, excerpt: String(body).slice(0, 1200).toWellFormed() }));
      store.finishAppUsage(usage, 'succeeded');
      return { items };
    } catch (error) {
      store.finishAppUsage(usage, 'failed');
      throw error;
    }
  }
  if (capability === 'document.refresh') {
    const after = input.after === undefined ? '' : requiredText(input.after, 'document cursor', 128);
    const result = await refreshDocumentPage(store, owner, workspace, connectionId, reader, after);
    if (store.connection(owner, connectionId, workspace)?.scopeVersion !== connection.scopeVersion ||
        (result.after !== null && store.resourceRevoked(connectionId, result.after))) {
      throw new RequestError(409, 'Source access changed during refresh');
    }
    return result;
  }
  const document = requiredText(input.document, 'document ID', 128);
  const operation = capability === 'document.test' ? 'test' : capability === 'document.read' ? 'read' : 'import';
  return accessDocument(store, owner, workspace, connectionId, reader, document, operation);
}

export async function runDueDocumentSync(store: DocumentMemory, readers: readonly DocumentConnector[],
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
