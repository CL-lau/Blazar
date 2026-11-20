export type TaskStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'waiting_user' | 'waiting_dependency' | 'waiting_device' | 'pausing' | 'paused';

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

export interface RunOutcome {
  status: 'succeeded' | 'failed';
  result: string;
  artifact?: { name: string; text: string };
}

export interface WorkflowStep {
  key: string;
  goal: string;
  needs: string[];
}
