import type { WorkflowAction, WorkflowStep } from '../../../packages/protocol/task.ts';

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
    if (value.acceptanceCriteria !== undefined && (!Array.isArray(value.acceptanceCriteria) ||
        value.acceptanceCriteria.length > 10 || value.acceptanceCriteria.some((criterion: unknown) =>
          typeof criterion !== 'string' || !criterion.trim() || criterion.trim().length > 500))) {
      throw new InvalidWorkflow('Invalid workflow acceptance criteria');
    }
    if (value.requireReview !== undefined && typeof value.requireReview !== 'boolean') {
      throw new InvalidWorkflow('Invalid workflow review option');
    }
    const action = value.action === undefined ? undefined : workflowAction(value.action);
    const protocols = value.workerProtocols;
    if (protocols !== undefined && (action || /^\/(observe|click|preview) /.test(value.goal) ||
        !Array.isArray(protocols) || !protocols.length || protocols.length > 6 ||
        protocols.some(protocol => !['acp', 'codex', 'claude', 'pi', 'aider', 'jsonl'].includes(protocol)))) {
      throw new InvalidWorkflow('Invalid workflow Worker protocols');
    }
    const acceptanceCriteria: string[] = Array.isArray(value.acceptanceCriteria)
      ? [...new Set<string>(value.acceptanceCriteria.map((criterion: string) => criterion.trim()))] : [];
    return { key: value.key as string, goal: value.goal as string, needs: [...new Set<string>(value.needs)],
      ...(action && { action }),
      ...(protocols && { workerProtocols: [...new Set<string>(protocols)].sort() }),
      ...(acceptanceCriteria.length && { acceptanceCriteria }), ...(value.requireReview === true && { requireReview: true }) };
  });
  orderWorkflow(steps);
  return steps;
}

function workflowAction(value: unknown): WorkflowAction {
  if (!value || typeof value !== 'object') throw new InvalidWorkflow('Invalid workflow action');
  const { kind, alias, deviceId, windowId, windowIdentity, button, expectedText } = value as Record<string, unknown>;
  if (typeof alias !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(alias) ||
      typeof deviceId !== 'string' || !/^[a-f0-9-]{36}$/.test(deviceId)) {
    throw new InvalidWorkflow('Invalid workflow desktop target');
  }
  if (kind === 'desktop.observe') return { kind, alias, deviceId };
  if (kind === 'desktop.click' && typeof windowId === 'string' && /^w-[0-9]{1,20}$/.test(windowId) &&
      typeof windowIdentity === 'string' && /^[a-f0-9]{64}$/.test(windowIdentity) &&
      typeof button === 'string' && button.trim() && button.length <= 120 && !/[\x00-\x1f\x7f]/.test(button)) {
    if (expectedText !== undefined && (typeof expectedText !== 'string' || !expectedText.trim() ||
        expectedText.length > 160 || /[\x00-\x1f\x7f]/.test(expectedText))) {
      throw new InvalidWorkflow('Invalid expected desktop text');
    }
    return { kind, alias, deviceId, windowId, windowIdentity, button,
      ...(expectedText && { expectedText: expectedText.trim() }) };
  }
  throw new InvalidWorkflow('Invalid workflow action');
}

export function workflowActionGoal(action: WorkflowAction): string {
  if (action.kind === 'desktop.observe') return '/observe ' + action.alias;
  return `/click ${action.alias} --window ${action.windowId} --instance ${action.windowIdentity} ${action.button}`;
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
