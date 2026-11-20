import type { WorkflowStep } from '../../packages/protocol/task.ts';

export class InvalidWorkflow extends Error {}

export function workflowSteps(input: unknown): WorkflowStep[] {
  if (!Array.isArray(input) || !input.length || input.length > 20) {
    throw new InvalidWorkflow('A workflow requires 1 to 20 steps');
  }
  const steps = input.map(value => {
    if (!value || typeof value !== 'object' || typeof value.key !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(value.key) || typeof value.goal !== 'string' ||
        !value.goal.trim() || value.goal.length > 32_000 || !Array.isArray(value.needs) ||
        value.needs.length > 20 || value.needs.some((item: unknown) => typeof item !== 'string')) {
      throw new InvalidWorkflow('Invalid workflow step');
    }
    return { key: value.key as string, goal: value.goal as string, needs: [...new Set<string>(value.needs)] };
  });
  orderWorkflow(steps);
  return steps;
}

export function orderWorkflow(steps: WorkflowStep[]) {
  const byKey = new Map(steps.map(step => [step.key, step]));
  if (!steps.length || steps.length > 20 || byKey.size !== steps.length) {
    throw new InvalidWorkflow('A workflow requires 1 to 20 uniquely named steps');
  }
  const ordered = new Map<string, WorkflowStep>();
  const visiting = new Set<string>();
  function visit(name: string) {
    if (ordered.has(name)) return;
    if (visiting.has(name)) throw new InvalidWorkflow('Workflow has a dependency cycle');
    const step = byKey.get(name);
    if (!step) throw new InvalidWorkflow('Unknown dependency: ' + name);
    visiting.add(name);
    for (const dependency of step.needs) visit(dependency);
    visiting.delete(name);
    ordered.set(name, step);
  }
  for (const step of steps) visit(step.key);
  return [...ordered.values()];
}
