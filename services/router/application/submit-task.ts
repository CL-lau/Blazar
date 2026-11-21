import { textAttachments } from '../domain/task-attachments.ts';
import type { MemoryStore } from '../memory.ts';
import { RequestError, requiredText } from '../protocol/request.ts';
import type { TaskStore } from '../store.ts';
import { selectAppEvidence } from './task-memory.ts';

export function submitTask(store: Pick<TaskStore, 'create' | 'get' | 'appEvidence' | 'ownsDesktopTarget'>,
                           memory: Pick<MemoryStore, 'personalContext' | 'recall'> | undefined,
                           owner: string, key: string, data: Record<string, unknown>, admin: boolean, caller?: string) {
  const workspace = requiredText(data.workspace, 'workspace', 128);
  const goal = requiredText(data.text, 'text', 32_000);
  if (goal.startsWith('/write ')) throw new RequestError(400, 'Desktop text edits require a structured workflow');
  const desktopDevice = data.desktopDevice;
  if (desktopDevice !== undefined) {
    const targetApp = /^\/(?:observe|click) ([a-z0-9_-]{1,32})(?: |$)/.exec(goal)?.[1];
    if (typeof desktopDevice !== 'string' || !/^[a-f0-9-]{36}$/.test(desktopDevice) ||
        !targetApp) throw new RequestError(400, 'Invalid desktop target');
    if (!store.ownsDesktopTarget(owner, workspace, desktopDevice, targetApp)) {
      throw new RequestError(404, 'Desktop target unavailable');
    }
  }
  if (data.usePersonalMemory !== undefined && typeof data.usePersonalMemory !== 'boolean') {
    throw new RequestError(400, 'Invalid task memory option');
  }
  if (data.usePersonalMemory && (!admin || /^\/(observe|click|preview) /.test(goal))) {
    throw new RequestError(403, 'Personal memory is only available for administrator Worker tasks');
  }
  if (data.usePersonalMemory && !memory) throw new RequestError(503, 'Memory is unavailable');
  const memoryInputs = data.usePersonalMemory ? memory!.personalContext(owner, workspace, goal) : undefined;
  let appEvidence;
  if (data.appMemory !== undefined) {
    if (!admin || desktopDevice || /^\/(observe|click|preview) /.test(goal)) {
      throw new RequestError(403, 'Application memory is only available for administrator Worker tasks');
    }
    appEvidence = selectAppEvidence(memory, owner, workspace, data.appMemory);
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
  const source = caller ? 'mobile-api:' + caller : 'desktop-api';
  return store.create(owner, source, key, workspace, goal, desktopDevice, memoryInputs,
    appEvidence, attachments, copiedFromTask);
}
