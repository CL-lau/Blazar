import type { PredecessorInput, TaskMemoryInput } from '../protocol/task.ts';

export type WorkerSteer = (text: string, messageId: string) => Promise<boolean>;
export type OnSteerReady = (steer: WorkerSteer) => () => void;

export type JobContext = {
  goal: string;
  instructions: string[];
  acceptanceCriteria?: string[];
  predecessors: PredecessorInput[];
  memoryInputs?: TaskMemoryInput[];
};

export function jobPrompt(job: JobContext) {
  return JSON.stringify({
    goal: job.goal,
    instructions: job.instructions.slice(-20).map(value => value.slice(0, 4_000)),
    ...(job.acceptanceCriteria?.length && { acceptanceCriteria: job.acceptanceCriteria }),
    ...(job.memoryInputs?.length && { backgroundMemory: job.memoryInputs }),
    predecessorResults: job.predecessors.map(value => ({ ...value, result: value.result?.slice(0, 4_000) })),
  });
}
