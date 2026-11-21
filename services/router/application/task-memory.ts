import type { MemoryStore } from '../memory.ts';
import type { TaskStore } from '../store.ts';

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
