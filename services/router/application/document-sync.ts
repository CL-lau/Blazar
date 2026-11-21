import { DocumentAccessDenied, DocumentUnavailable, type DocumentConnector, type DocumentCapabilityId } from '../../../packages/apps/documents.ts';
import type { MemoryStore } from '../memory.ts';
import { RequestError, requiredText } from '../protocol/request.ts';

type DocumentMemory = Pick<MemoryStore, 'connection' | 'documentSyncActive' | 'documentsToRefresh' |
  'finishAppUsage' | 'finishDocumentSync' | 'importDocument' | 'leaseDocumentSync' |
  'recordDocumentAccess' | 'resourceRevoked' | 'startAppUsage'>;

export async function accessDocument(store: DocumentMemory, owner: string, workspace: string, connection: string,
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
  if (capability === 'document.refresh') {
    const after = input.after === undefined ? '' : requiredText(input.after, 'document cursor', 128);
    return refreshDocumentPage(store, owner, workspace, connectionId, reader, after);
  }
  const document = requiredText(input.document, 'document ID', 128);
  return accessDocument(store, owner, workspace, connectionId, reader, document, capability === 'document.test' ? 'test' : 'import');
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
