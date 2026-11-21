import type { MemoryAnswer } from '../harness.ts';
import type { MemoryStore } from '../memory.ts';
import { RequestError, requiredText } from '../protocol/request.ts';

export async function answerFromMemory(store: Pick<MemoryStore, 'connection' | 'recall'>, answerMemory: MemoryAnswer | undefined,
                                       owner: string, workspace: string, question: string, data: Record<string, unknown>,
                                       signal: AbortSignal, reserve: (signal: AbortSignal) => Promise<() => void>) {
  const query = requiredText(data.query, 'search terms', 256);
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
    return { answer: null, sources: [] };
  }
  if (!answerMemory) throw new RequestError(503, 'Blazar has no Router model configured');
  const connections = new Set(sources.flatMap(row => typeof row.connection === 'string' ? [row.connection] : []));
  const scopeVersion = (id: string) => store.connection(owner, id, workspace)?.scopeVersion;
  const sourceScopes = [...connections].map(id => [id, scopeVersion(id)] as const);
  const evidence = sources.map(row => ({
    id: String(row.id), body: String(row.body).slice(0, 2_000).toWellFormed(),
    resource: row.resource === null ? null : String(row.resource),
    revision: row.revision === null ? null : String(row.revision),
  }));
  const checkSources = () => {
    signal.throwIfAborted();
    const current = recall();
    if (sourceScopes.some(([id, version]) => scopeVersion(id) !== version) ||
        sources.some(row => !current.some(item => item.id === row.id && item.version === row.version))) {
      throw new RequestError(409, 'Memory sources changed while answering. Run the search again.');
    }
  };
  const release = await reserve(signal);
  let answer: string;
  try {
    checkSources();
    answer = (await answerMemory(question, evidence, AbortSignal.any([signal, AbortSignal.timeout(15_000)]))).trim();
    if (!answer || answer.length > 8_000) throw new Error('Invalid model response');
  } catch {
    checkSources();
    throw new RequestError(503, 'Blazar could not answer from memory. Please retry.');
  } finally {
    release();
  }
  checkSources();
  return { answer, sources: sources.map(({ id, connection, resource, revision }) => ({ id, connection, resource, revision })) };
}
