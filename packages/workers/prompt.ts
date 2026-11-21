import type { PredecessorInput, RunHistoryEntry, TaskAttachment, TaskMemoryInput } from '../protocol/task.ts';

export type WorkerSteer = (text: string, messageId: string) => Promise<boolean>;
export type OnSteerReady = (steer: WorkerSteer) => () => void;

export type JobContext = {
  goal: string;
  instructions: string[];
  acceptanceCriteria?: string[];
  predecessors: PredecessorInput[];
  memoryInputs?: TaskMemoryInput[];
  attachments?: TaskAttachment[];
  runHistory?: RunHistoryEntry[];
  previousQuestion?: string;
};

export function jobPrompt(job: JobContext) {
  return JSON.stringify({
    goal: job.goal,
    instructions: job.instructions.slice(-20).map(value => value.slice(0, 4_000)),
    ...(job.acceptanceCriteria?.length && { acceptanceCriteria: job.acceptanceCriteria }),
    ...(job.memoryInputs?.length && { backgroundMemory: job.memoryInputs }),
    ...(job.attachments?.length && { attachments: job.attachments }),
    ...(job.previousQuestion && { previousQuestion: job.previousQuestion }),
    ...(job.runHistory?.length && { previousRuns: job.runHistory }),
    predecessorResults: job.predecessors.map(value => ({ ...value, result: value.result?.slice(0, 4_000) })),
  });
}
