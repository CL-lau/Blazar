export type TaskStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'waiting_user' | 'waiting_dependency' | 'waiting_device' | 'pausing' | 'paused' | 'waiting_review';

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
  artifact?: { name: string; text: string; mime?: 'image/png' };
}

export interface WorkflowStep {
  key: string;
  goal: string;
  needs: string[];
  acceptanceCriteria?: string[];
  requireReview?: boolean;
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
