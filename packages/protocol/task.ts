export type TaskStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'waiting_user' | 'waiting_dependency' | 'waiting_device' | 'pausing' | 'paused' | 'waiting_review';

const chineseTaskStates: Record<TaskStatus, string> = {
  queued: '排队中', running: '运行中', cancelling: '正在取消', cancelled: '已取消',
  succeeded: '已完成', failed: '失败', waiting_user: '等待用户', waiting_dependency: '等待依赖',
  waiting_device: '等待设备', pausing: '正在暂停', paused: '已暂停', waiting_review: '等待验收',
};

export function displayTaskStatus(status: string, chinese: boolean) {
  return (chinese && chineseTaskStates[status as TaskStatus]) || status.replaceAll('_', ' ');
}
export interface Task {
  id: string;
  owner: string;
  workspace: string;
  goal: string;
  version: number;
  status: TaskStatus;
  result: string | null;
}

export interface Run {
  id: string;
  taskId: string;
  device: string;
  version: number;
  expires: number;
}

export interface TaskEvent {
  seq: number;
  taskId: string;
  type: string;
  data: string;
}

export const windowImageLifetimeMs = 5 * 60_000;

export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'waiting_user';
  result: string;
  artifact?: { name: string; text: string; mime?: 'image/png' };
}

export type WorkflowAction =
  | { kind: 'desktop.observe'; alias: string; deviceId: string }
  | { kind: 'desktop.click'; alias: string; deviceId: string; windowId: string; windowIdentity: string; button: string; expectedText?: string };

export interface WorkflowStep {
  key: string;
  goal: string;
  needs: string[];
  acceptanceCriteria?: string[];
  requireReview?: boolean;
  action?: WorkflowAction;
}


export interface TaskMemoryInput {
  id: string;
  version: number;
  body: string;
}

export interface DesktopAppControls {
  alias: string;
  buttons: string[];
  visual: boolean;
}

export interface TaskAttachment {
  name: string;
  text: string;
}

export interface WorkerConfiguration {
  label: string;
  protocol: string;
  adapterVersion?: number;
  revision?: string;
}


export interface PredecessorInput {
  taskId: string;
  version: number;
  result: string | null;
  artifact?: { id: string; name: string; sha256: string; excerpt: string; truncated: boolean; size: number; text?: string };
}
