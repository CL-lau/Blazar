export type JobContext = {
  goal: string;
  instructions: string[];
  predecessors: { taskId: string; version: number; result: string | null }[];
};

export function jobPrompt(job: JobContext) {
  return JSON.stringify({
    goal: job.goal,
    instructions: job.instructions.slice(-20).map(value => value.slice(0, 4_000)),
    predecessorResults: job.predecessors.map(value => ({ ...value, result: value.result?.slice(0, 4_000) })),
  });
}
