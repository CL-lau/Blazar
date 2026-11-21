import type { DocumentConnector } from '../../../packages/apps/documents.ts';
import type { MemoryAnswer } from '../harness.ts';
import type { MemoryStore } from '../memory.ts';
import { RequestError, requiredText } from '../protocol/request.ts';
import { accessDocument } from './document-sync.ts';

export async function answerFromDocuments(store: MemoryStore, readers: readonly DocumentConnector[],
                                          generate: MemoryAnswer | undefined, owner: string, workspace: string,
                                          question: string, input: unknown) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 4) {
    throw new RequestError(400, 'Choose one to four source documents');
  }
  const seen = new Set<string>();
  const requested = input.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400, 'Invalid source document');
    const connection = requiredText(value.connection, 'connection', 36);
    const resource = requiredText(value.resource, 'document reference', 128);
    const revision = value.revision === undefined ? undefined : requiredText(value.revision, 'document revision', 128);
    if (!/^[a-f0-9-]{36}$/.test(connection)) throw new RequestError(400, 'Invalid source connection');
    const key = JSON.stringify([connection, resource]);
    if (seen.has(key)) throw new RequestError(400, 'Duplicate source document');
    seen.add(key);

    const app = store.connection(owner, connection, workspace);
    if (!app) throw new RequestError(404, 'Active connection not found');
    const reader = readers.find(item => item.app === app.app && item.account === app.account);
    if (!reader) throw new RequestError(409, 'No document reader is configured for this connection');
    if (!reader.accepts(resource)) throw new RequestError(400, 'Invalid document reference');
    return { connection, resource, revision, reader };
  });
  if (!generate) throw new RequestError(503, 'Blazar has no Router model configured');
  const checks: (() => boolean)[] = [];
  const documents = await Promise.all(requested.map(({ connection, resource, reader }) =>
    accessDocument(store, owner, workspace, connection, reader, resource, 'read', undefined, undefined,
      check => checks.push(check))));
  const sources = documents.map((result, index) => {
    if (!('text' in result) || typeof result.text !== 'string') throw new RequestError(502, 'Document preview is unavailable');
    if (requested[index].revision !== undefined && requested[index].revision !== result.revision) {
      throw new RequestError(409, 'A selected document has changed. Preview the new version before asking Blazar.');
    }
    return { id: String(index + 1), connection: result.connection, resource: result.resource, revision: result.revision,
      body: result.text.slice(0, 2_000).toWellFormed() };
  });
  const checkSources = () => {
    if (checks.length !== sources.length || checks.some(check => !check())) {
      throw new RequestError(409, 'Document access changed while preparing the answer');
    }
  };
  checkSources();
  let answer: string;
  try {
    answer = (await generate(question, sources.map(({ id, body, resource, revision }) => ({ id, body, resource, revision })),
      AbortSignal.timeout(15_000))).trim();
    if (!answer || answer.length > 8_000) throw new Error('Invalid model response');
  } catch {
    checkSources();
    throw new RequestError(503, 'Blazar could not answer from the selected documents. Please retry.');
  }
  checkSources();
  return { answer, sources: sources.map(({ id, connection, resource, revision }) => ({ id, connection, resource, revision })) };
}
