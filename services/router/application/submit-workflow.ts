import { workflowSteps } from '../domain/workflow.ts';
import { RequestError, requiredText } from '../protocol/request.ts';
import type { MemoryStore } from '../memory.ts';
import type { TaskStore } from '../store.ts';
import { selectAppEvidence } from './task-memory.ts';

export function submitWorkflow(store: Pick<TaskStore, 'createWorkflow' | 'desktopTargets'>,
                               memory: MemoryStore | undefined, owner: string, key: string,
                               data: Record<string, unknown>, admin: boolean, caller?: string) {
  const workspace = requiredText(data.workspace, 'workspace', 128);
  const steps = workflowSteps(data.steps);
  if (steps.some(step => step.goal.startsWith('/observe ') || step.goal.startsWith('/click '))) {
    throw new RequestError(400, 'Desktop operations require a direct task request');
  }
  const desktopSteps = steps.flatMap(step => step.action ? [step.action] : []);
  if (desktopSteps.length) {
    const targets = store.desktopTargets(owner);
    if (desktopSteps.some(action => !targets.some(target => target.workspace === workspace &&
        target.deviceId === action.deviceId && target.alias === action.alias &&
        (action.kind === 'desktop.observe'
          ? (action.mode !== 'visual' && action.mode !== 'hybrid') || (target.controls?.visual === true && target.screenRecording !== 'denied')
          : target.controls?.buttons.includes(action.button))))) {
      throw new RequestError(404, 'Workflow desktop target unavailable');
    }
    if (data.appMemory !== undefined) throw new RequestError(400, 'Desktop workflow steps cannot use application memory');
  }
  if (data.appMemory !== undefined && (!admin || steps.some(step => step.goal.startsWith('/preview ')))) {
    throw new RequestError(403, 'Application memory requires an administrator Worker workflow');
  }
  const appEvidence = data.appMemory === undefined ? undefined :
    selectAppEvidence(memory, owner, workspace, data.appMemory);
  const proposalKey = data.proposalKey === undefined ? undefined : requiredText(data.proposalKey, 'proposal key', 128);
  return store.createWorkflow(owner, key, workspace, steps, appEvidence, caller, proposalKey);
}
