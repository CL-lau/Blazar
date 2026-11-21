import { workerCapabilities, type DesktopWindowReference, type WorkflowAction, type WorkflowStep } from '../../../packages/protocol/task.ts';

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
    const capability = workerCapabilities.find(item => item === value.workerCapability);
    if (value.workerCapability !== undefined && (!capability || action || /^\/(observe|click|preview) /.test(value.goal))) {
      throw new InvalidWorkflow('Invalid workflow Worker capability');
    }
    const runLimitSeconds = value.runLimitSeconds;
    if (runLimitSeconds !== undefined && (typeof runLimitSeconds !== 'number' ||
        !Number.isSafeInteger(runLimitSeconds) || runLimitSeconds < 30 || runLimitSeconds > 600)) {
      throw new InvalidWorkflow('Invalid workflow step time limit');
    }
    const acceptanceCriteria: string[] = Array.isArray(value.acceptanceCriteria)
      ? [...new Set<string>(value.acceptanceCriteria.map((criterion: string) => criterion.trim()))] : [];
    return { key: value.key as string, goal: value.goal as string, needs: [...new Set<string>(value.needs)],
      ...(action && { action }),
      ...(runLimitSeconds !== undefined && { runLimitSeconds }),
      ...(capability && { workerCapability: capability }),
      ...(protocols && { workerProtocols: [...new Set<string>(protocols)].sort() }),
      ...(acceptanceCriteria.length && { acceptanceCriteria }), ...(value.requireReview === true && { requireReview: true }) };
  });
  orderWorkflow(steps);
  return steps;
}

function workflowAction(value: unknown): WorkflowAction {
  if (!value || typeof value !== 'object') throw new InvalidWorkflow('Invalid workflow action');
  const { kind, alias, deviceId, windowId, windowIdentity, button, expectedText, mode, windowFrom, waitSeconds } = value as Record<string, unknown>;
  if (typeof alias !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(alias) ||
      typeof deviceId !== 'string' || !/^[a-f0-9-]{36}$/.test(deviceId)) {
    throw new InvalidWorkflow('Invalid workflow desktop target');
  }
  let reference: { step: string; title: string } | undefined;
  if (windowFrom && typeof windowFrom === 'object' && windowId === undefined && windowIdentity === undefined) {
    const { step, title } = windowFrom as Record<string, unknown>;
    if (typeof step === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(step) &&
        typeof title === 'string' && title.trim() && title.length <= 200 && !/[\x00-\x1f\x7f]/.test(title)) {
      reference = { step, title };
    }
  }
  if (expectedText !== undefined && (typeof expectedText !== 'string' || !expectedText.trim() ||
      expectedText.length > 160 || /[\x00-\x1f\x7f]/.test(expectedText))) {
    throw new InvalidWorkflow('Invalid expected desktop text');
  }
  const expectation = expectedText ? { expectedText: expectedText.trim() } : {};
  if (waitSeconds !== undefined && (kind !== 'desktop.observe' || mode !== 'window' || !expectedText ||
      typeof waitSeconds !== 'number' || !Number.isSafeInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 20)) {
    throw new InvalidWorkflow('Invalid desktop observation wait');
  }
  if (kind === 'desktop.observe' && mode === 'visual' && reference && expectedText === undefined) {
    return { kind, alias, deviceId, mode, windowFrom: reference };
  }
  if (kind === 'desktop.observe' && mode === 'window' && reference) {
    return { kind, alias, deviceId, mode, windowFrom: reference, ...expectation, ...(waitSeconds !== undefined && { waitSeconds }) };
  }
  if (kind === 'desktop.observe' && (mode === undefined || mode === 'windows') && windowFrom === undefined && expectedText === undefined) {
    return { kind, alias, deviceId, ...(mode && { mode }) };
  }
  if (kind === 'desktop.click' && typeof button === 'string' && button.trim() &&
      button.length <= 120 && !/[\x00-\x1f\x7f]/.test(button)) {
    const click = { kind, alias, deviceId, button, ...expectation } as const;
    if (windowFrom === undefined && typeof windowId === 'string' && /^w-[0-9]{1,20}$/.test(windowId) &&
        typeof windowIdentity === 'string' && /^[a-f0-9]{64}$/.test(windowIdentity)) {
      return { ...click, windowId, windowIdentity };
    }
    if (reference) return { ...click, windowFrom: reference };
  }
  throw new InvalidWorkflow('Invalid workflow action');
}

export function workflowActionGoal(action: WorkflowAction, observed?: DesktopWindowReference): string {
  if (action.kind === 'desktop.observe') {
    if (action.mode === 'window' || action.mode === 'visual') return observed
      ? `/observe ${action.alias} --window ${observed.windowId} --instance ${observed.windowIdentity}${action.mode === 'visual' ? ' --visual' : ''}`
      : `/observe ${action.alias} [resolve workflow window]`;
    return '/observe ' + action.alias + (action.mode === 'windows' ? ' --windows-json' : '');
  }
  const target = 'windowFrom' in action ? observed : action;
  return target ? `/click ${action.alias} --window ${target.windowId} --instance ${target.windowIdentity} ${action.button}`
    : `/click ${action.alias} [resolve workflow window]`;
}

export function resolveWorkflowWindow(inventory: string, title: string): DesktopWindowReference | undefined {
  let windows: unknown;
  try { windows = JSON.parse(inventory); } catch { return undefined; }
  if (!Array.isArray(windows) || windows.length > 25) return undefined;
  const matches = windows.filter(item => item && typeof item === 'object' && item.title === title);
  if (matches.length !== 1) return undefined;
  const { id, identity, accessible } = matches[0];
  if (accessible !== true || typeof id !== 'string' || !/^w-[0-9]{1,20}$/.test(id) ||
      typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity)) return undefined;
  return { windowId: id, windowIdentity: identity };
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
    const action = step.action;
    if (action && 'windowFrom' in action) {
      const source = byKey.get(action.windowFrom.step)?.action;
      if (!step.needs.includes(action.windowFrom.step) || source?.kind !== 'desktop.observe' || source.mode !== 'windows' ||
          source.alias !== action.alias || source.deviceId !== action.deviceId) {
        throw new InvalidWorkflow('The action must directly depend on a window inventory of the same device and app');
      }
    }
    visiting.add(name);
    for (const dependency of step.needs) visit(dependency);
    visiting.delete(name);
    ordered.set(name, step);
  }
  for (const step of steps) visit(step.key);
  return [...ordered.values()];
}
