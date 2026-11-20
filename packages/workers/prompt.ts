import type { PredecessorInput } from '../protocol/task.ts';

export type JobContext = {
  goal: string;
  instructions: string[];
  acceptanceCriteria?: string[];
  predecessors: PredecessorInput[];
};

export function jobPrompt(job: JobContext) {
  return JSON.stringify({
    goal: job.goal,
    instructions: job.instructions.slice(-20).map(value => value.slice(0, 4_000)),
    ...(job.acceptanceCriteria?.length && { acceptanceCriteria: job.acceptanceCriteria }),
    predecessorResults: job.predecessors.map(value => ({ ...value, result: value.result?.slice(0, 4_000) })),
  });
}
