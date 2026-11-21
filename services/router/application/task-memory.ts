import type { MemoryStore } from '../memory.ts';
import { RequestError, requiredText } from '../protocol/request.ts';
import type { AppEvidence, TaskStore } from '../store.ts';

export function workerMemoryAvailable(
  store: Pick<TaskStore, 'appEvidence' | 'personalEvidence'>,
  memory: Pick<MemoryStore, 'resolveAppEvidence' | 'resolvePersonalEvidence'> | undefined,
  owner: string, workspace: string, taskId: string,
) {
  const app = store.appEvidence(taskId);
  const personal = store.personalEvidence(taskId);
  return (!app || Boolean(memory?.resolveAppEvidence(owner, workspace, app))) &&
    (!personal.length || Boolean(memory?.resolvePersonalEvidence(owner, workspace, personal)));
}

export function selectAppEvidence(memory: MemoryStore | undefined, owner: string, workspace: string, value: unknown): AppEvidence {
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
