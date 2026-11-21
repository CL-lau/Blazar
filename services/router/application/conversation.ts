import { performance } from 'node:perf_hooks';
import { displayTaskStatus } from '../../../packages/protocol/task.ts';
import type { DocumentConnector } from '../../../packages/apps/documents.ts';
import type { Decision, RouteRequest, RouterHarness } from '../harness.ts';
import type { MemoryStore } from '../memory.ts';
import type { RouterMetrics } from '../metrics.ts';
import { IdempotencyConflict } from '../domain/idempotency.ts';
import type { TaskStore } from '../store.ts';

export class ConversationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ConversationTasks = Pick<TaskStore, 'findRouterTasks' | 'routingDecision' | 'persistRoutingDecision' |
  'recentConversation' | 'get' | 'recentTaskEventTypes' | 'desktopTargets' | 'devices' | 'create' | 'latestTaskText' | 'appEvidence' | 'personalEvidence'>;

interface ConversationDependencies {
  harness?: RouterHarness;
  memory?: Pick<MemoryStore, 'personalContext' | 'connections'>;
  documents?: readonly DocumentConnector[];
}

interface ConversationRequest {
  owner: string;
  caller: string;
  admin: boolean;
  key: string;
  input: RouteRequest;
  metrics: RouterMetrics;
  authorized: () => boolean;
  canReadTask: (taskId: string) => boolean;
}

export function createConversationRouter(store: ConversationTasks, config: ConversationDependencies) {
  const modelRoutesByCaller = new Map<string, number>();
  let modelRoutes = 0;
  const pendingRoutes = new Map<string, { fingerprint: string; decision: Promise<Decision> }>();

  return async function routeConversation({ owner, caller, admin, key, input, metrics, authorized, canReadTask }: ConversationRequest) {
    const status = /^\/(status|状态)(?: (.*))?$/.exec(input.text);
    if (status) {
      const query = status[2]?.trim() ?? '';
      if (query.length > 128) throw new ConversationError(400, 'Invalid task query');
      const tasks = store.findRouterTasks(owner, input.workspace, query, admin)
        .filter(task => canReadTask(task.id));
      const text = tasks.length ? tasks.map(task =>
        `${displayTaskStatus(task.status, status[1] === '状态')} · ${task.goal.replace(/\s+/g, ' ')}`
      ).join('\n') : status[1] === '状态' ? '没有找到匹配的任务。' : 'No matching tasks.';
      metrics.route('deterministic');
      return { status: 200, body: { kind: 'reply', text } };
    }
    let decision = store.routingDecision(owner, key, input, undefined, caller);
    if (decision) metrics.route('replayed');
    else {
      const pendingKey = JSON.stringify([owner, caller, key]);
      const fingerprint = JSON.stringify(input);
      const pending = pendingRoutes.get(pendingKey);
      if (pending) {
        if (pending.fingerprint !== fingerprint) throw new IdempotencyConflict();
        decision = await pending.decision;
        metrics.route('replayed');
      } else {
        const route = async () => {
          let decision: Decision;
          if (input.text.startsWith('/preview ') || input.text.startsWith('/observe ') || input.text.startsWith('/click ')) {
            decision = { kind: 'create_task' };
            metrics.route('deterministic');
          }
          else if (!config.harness) throw new ConversationError(503, 'Blazar has no Router model configured');
          else {
            const evidenceVersions = new Map<string, number>();
            const findOne = (query: string) => {
              const exact = /^[a-f0-9-]{36}$/.test(query);
              const candidates = exact ? [store.get(owner, query)].filter(task => task?.workspace === input.workspace)
                : store.findRouterTasks(owner, input.workspace, query);
              return candidates.length === 1 ? candidates[0] : undefined;
            };
            const foundVersions = new Map<string, number>();
            const recall = () => input.usePersonalMemory
              ? config.memory?.personalContext(owner, input.workspace, input.text) ?? [] : [];
            const evidence = recall();
            const modelStarted = performance.now();
            const modelScope = JSON.stringify([owner, caller]);
            const callerRoutes = modelRoutesByCaller.get(modelScope) ?? 0;
            if (modelRoutes >= 16 || callerRoutes >= 4) {
              throw new ConversationError(429, 'Blazar routing is busy. Please retry.');
            }
            modelRoutes++;
            modelRoutesByCaller.set(modelScope, callerRoutes + 1);
            metrics.route('model');
            try {
              decision = await config.harness({
                ...input, recent: store.recentConversation(owner, input.workspace, caller),
                findTasks: query => {
                  const tasks = store.findRouterTasks(owner, input.workspace, query).filter(task => canReadTask(task.id));
                  for (const task of tasks) foundVersions.set(task.id, task.version);
                  return tasks;
                },
                taskEvents: query => {
                  const task = findOne(query);
                  if (!task || !canReadTask(task.id)) return undefined;
                  return store.recentTaskEventTypes(owner, input.workspace, task.id);
                },
                taskResult: query => {
                  const candidate = findOne(query);
                  const task = candidate && store.get(owner, candidate.id);
                  if (!task || task.status !== 'succeeded' || !canReadTask(task.id) ||
                      store.appEvidence(task.id) || store.personalEvidence(task.id).length) return undefined;
                  evidenceVersions.set(task.id, task.version);
                  return { taskId: task.id, version: task.version, result: task.result?.slice(0, 1200).toWellFormed() ?? null,
                    artifact: store.latestTaskText(task.id, task.version) };
                },
                ...(admin && { workspaceCapabilities: () => ({
                  desktopTargets: store.desktopTargets(owner).filter(target => target.workspace === input.workspace)
                    .slice(0, 16).map(target => ({ alias: String(target.alias), deviceId: String(target.deviceId) })),
                  devices: store.devices(owner).filter(device => device.workspace === input.workspace && !device.revoked)
                    .slice(0, 16).map(device => ({
                      name: String(device.name), capability: String(device.capability ?? 'unreported'),
                      online: Boolean(device.online),
                      available: Boolean(device.online && !device.paused && !device.workerPolicyBlocked && !device.interruptedRunId),
                    })),
                  apps: (config.memory?.connections(owner) ?? [])
                    .filter(connection => connection.active && (!connection.workspace || connection.workspace === input.workspace))
                    .slice(0, 16).map(connection => ({
                      app: connection.app,
                      documentRead: Boolean(config.documents?.some(connector =>
                        connector.app === connection.app && connector.account === connection.account)),
                    })),
                }) }),
                ...(evidence.length ? { personalMemory: evidence.map(item => item.body) } : {}),
              }, AbortSignal.timeout(15_000), usage => metrics.recordModelUsage(usage));
            } catch {
              metrics.route('modelErrors');
              throw new ConversationError(503, 'Blazar could not make a routing decision. Please retry.');
            } finally {
              modelRoutes--;
              const remaining = (modelRoutesByCaller.get(modelScope) ?? 1) - 1;
              if (remaining) modelRoutesByCaller.set(modelScope, remaining);
              else modelRoutesByCaller.delete(modelScope);
              metrics.observe('model', performance.now() - modelStarted);
            }
            if (evidence.length) {
              const current = recall();
              if (evidence.some(item => !current.some(note => note.id === item.id && note.version === item.version))) {
                throw new ConversationError(409, 'Personal memory changed while routing. Please retry.');
              }
            }
            for (const [taskId, version] of evidenceVersions) {
              const task = store.get(owner, taskId);
              if (task?.version !== version || task.status !== 'succeeded' || !canReadTask(taskId)) {
                throw new ConversationError(409, 'Task result changed while routing. Please retry.');
              }
            }
            if (decision.kind === 'append_task') {
              const version = foundVersions.get(decision.taskId);
              const task = store.get(owner, decision.taskId);
              if (!task || task.workspace !== input.workspace || task.version !== version ||
                  /^\/(observe|click|preview) /.test(task.goal) ||
                  ['cancelling', 'cancelled', 'pausing', 'paused'].includes(task.status)) {
                throw new ConversationError(409, 'The proposed follow-up target changed or is unavailable');
              }
              decision = { ...decision, expectedVersion: version };
            }
          }
          if (!authorized()) throw new ConversationError(401, 'Authentication required');
          if (decision.kind === 'create_task' && decision.goal && decision.goal !== input.text &&
              /^\/(observe|click) /.test(decision.goal)) {
            throw new ConversationError(400, 'Application observation requires an explicit command');
          }
          return store.persistRoutingDecision(owner, caller, key, input, decision);
        };
        const routed = route();
        pendingRoutes.set(pendingKey, { fingerprint, decision: routed });
        try {
          decision = await routed;
        } finally {
          pendingRoutes.delete(pendingKey);
        }
      }
    }
    if (!authorized()) throw new ConversationError(401, 'Authentication required');
    if (decision.kind === 'create_task') {
      const goal = decision.goal ?? input.text;
      if ((goal.startsWith('/observe ') || goal.startsWith('/click ')) && goal !== input.text) {
        throw new ConversationError(400, 'Application observation requires an explicit command');
      }
      const task = store.create(owner, admin ? 'conversation' : 'conversation:' + caller, key, input.workspace, goal);
      return { status: 202, body: { kind: decision.kind, task } };
    }
    return { status: 200, body: decision };
  };
}
