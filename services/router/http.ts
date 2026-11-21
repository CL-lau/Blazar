import { handleApplicationWrites } from './transport/app-write-routes.ts';
import type { ConfiguredApplicationWrite } from '../../packages/apps/config.ts';
import { jsonBody, jsonObject, reply } from './transport/json.ts';
import { handleMemory } from './transport/memory-routes.ts';
import { StaleRoutingEvidence } from './domain/idempotency.ts';
import { deviceOperation } from './application/device-operation.ts';
import { submitWorkflow } from './application/submit-workflow.ts';
import { streamTaskEvents } from './transport/task-stream.ts';
import { submitTask } from './application/submit-task.ts';
import { textAttachments } from './domain/task-attachments.ts';
import { workerMemoryAvailable } from './application/task-memory.ts';
import { RequestError, requiredText } from './protocol/request.ts';
import type { Task, TaskAttachment } from '../../packages/protocol/task.ts';
import { ConversationError, createConversationRouter } from './application/conversation.ts';
import { ModelAdmission } from './application/model-admission.ts';
import { artifactDiff } from './artifact-diff.ts';
import { createWorkerRegistry } from './application/worker-registry.ts';
import { handleAdmin } from './transport/admin-routes.ts';
import { performance } from 'node:perf_hooks';
import { RouterMetrics, type StreamHealth } from './metrics.ts';
import type { DocumentConnector } from '../../packages/apps/documents.ts';
import { createDeviceSocketTransport, maxDeviceClaimBytes, maxDeviceFinishBytes } from './transport/device-sockets.ts';
import { createQQHandler, qqChannel, type QQConfig } from '../../packages/channels/qq.ts';
import { feishuChannel, parseFeishu, type FeishuConfig } from '../../packages/channels/feishu.ts';
import { InvalidWorkflow } from './domain/workflow.ts';
import type { MemoryAnswer, MemoryDraft, RouteRequest, RouterHarness } from './harness.ts';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { MemoryStore } from './memory.ts';
import { IdempotencyConflict, TaskStore } from './store.ts';

type StreamChannelSettings = Partial<Record<'weixin' | 'wecom' | 'dingtalk', { workspace: string; health?: () => StreamHealth | undefined }>>;

export function routerServer(store: TaskStore, config: { owner: string; token: string; memory?: MemoryStore; harness?: RouterHarness; feishu?: FeishuConfig; lark?: FeishuConfig; readLarkAttachment?: (messageId: string, key: string) => Promise<string | undefined>; readFeishuAttachment?: (messageId: string, key: string) => Promise<string | undefined>; qq?: QQConfig; readQQAttachment?: (url: string, name?: string) => Promise<TaskAttachment | undefined>; documents?: readonly DocumentConnector[]; applicationWrites?: readonly ConfiguredApplicationWrite[]; answerMemory?: MemoryAnswer; draftMemory?: MemoryDraft; pushEnabled?: boolean; streamChannels?: StreamChannelSettings }) {
  const metricsByOwner = new Map<string, RouterMetrics>();
  function ownerMetrics(owner: string) {
    let metrics = metricsByOwner.get(owner);
    if (!metrics) {
      metrics = new RouterMetrics();
      metricsByOwner.set(owner, metrics);
    }
    return metrics;
  }
  const workerRegistry = createWorkerRegistry();
  const admission = new ModelAdmission();
  const routeConversation = createConversationRouter(store, config, admission);
  const devices = createDeviceSocketTransport(store);
  const expireRuns = (now: number) => store.expire(now, devices.sendStop);
  function notifyStop(owner: string, taskId: string) {
    const target = store.stopTarget(owner, taskId);
    if (target) devices.sendStop(target.device, target.runId);
  }
  async function attachFromChannel(channel: string, workspace: string,
                                   message: Parameters<TaskStore['channelAttachmentTask']>[3],
                                   download: () => Promise<TaskAttachment | undefined>) {
    const task = store.channelAttachmentTask(config.owner, channel, workspace, message);
    if (!task) return;
    let file;
    try { file = await download(); }
    catch { throw new RequestError(503, 'Attachment download failed'); }
    if (!file) return;
    let attachment: TaskAttachment;
    try { [attachment] = textAttachments([file]); }
    catch (error) {
      if (error instanceof RequestError) return;
      throw error;
    }
    if (store.addChannelAttachment(config.owner, channel, workspace, String(task.id), message, attachment)) {
      notifyStop(config.owner, String(task.id));
    }
  }
  function flushStopNotifications() {
    const checked = new Map<string, boolean>();
    for (const task of store.pendingMemoryTasks()) {
      const key = JSON.stringify([task.owner, task.workspace, task.appRefs, task.personalRefs]);
      let allowed = checked.get(key);
      if (allowed === undefined) {
        const personal = JSON.parse(task.personalRefs);
        allowed = (!task.appRefs || Boolean(config.memory?.resolveAppEvidence(task.owner, task.workspace, JSON.parse(task.appRefs)))) &&
          (!personal.length || Boolean(config.memory?.resolvePersonalEvidence(task.owner, task.workspace, personal)));
        checked.set(key, allowed);
      }
      if (!allowed) {
        if (task.run) store.requestRunEvidenceStop(task.run.id, task.run.device);
        else store.suspendTaskForMemory(task.id);
      }
    }
    devices.flushStops();
  }
  const expected = Buffer.from(`Bearer ${config.token}`);
  const qq = config.qq ? createQQHandler(config.qq) : undefined;
  const server = createServer(async (request, response) => {
    const started = performance.now();
    try {
      const auth = request.headers.authorization ?? '';
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/v1/health' && !url.search) {
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
        if (!local || request.headers['x-blazar-public-gateway'] !== undefined) {
          throw new RequestError(404, 'Not found');
        }
        reply(response, 200, { service: 'blazar-router', status: 'ready' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/channels/qq/events' && qq && config.qq) {
        const { body, raw } = await jsonBody(request);
        const event = qq(body, raw, request.headers['x-signature-timestamp'],
          request.headers['x-signature-ed25519'], Date.now());
        if (event.kind === 'unauthorized') throw new RequestError(401, 'Channel authentication required');
        if (event.kind === 'challenge') {
          reply(response, 200, { plain_token: event.plain_token, signature: event.signature });
        } else {
          if (event.kind === 'message') {
            store.receiveChannelMessage(config.owner, qqChannel(config.qq),
              config.qq.workspace, event.message);
            flushStopNotifications();
            ownerMetrics(config.owner).observe('qq', performance.now() - started);
          }
          if (event.kind === 'attachment' && config.readQQAttachment) {
            const read = config.readQQAttachment;
            await attachFromChannel(qqChannel(config.qq), config.qq.workspace, event.message, () => read(event.url, event.name));
          }
          reply(response, 200, { op: 12 });
        }
        return;
      }
      const larkCallback = url.pathname === '/v1/channels/lark/events';
      const collaboration = larkCallback ? config.lark : url.pathname === '/v1/channels/feishu/events' ? config.feishu : undefined;
      if (request.method === 'POST' && collaboration) {
        const channel = feishuChannel(collaboration, larkCallback ? 'lark' : 'feishu');
        const readAttachment = larkCallback ? config.readLarkAttachment : config.readFeishuAttachment;
        const event = parseFeishu(await jsonObject(request), collaboration);
        if (event.kind === 'unauthorized') throw new RequestError(401, 'Channel authentication required');
        if (event.kind === 'challenge') {
          reply(response, 200, { challenge: event.value });
          return;
        }
        if (event.kind === 'message') {
          store.receiveChannelMessage(config.owner, channel, collaboration.workspace, event);
          flushStopNotifications();
          ownerMetrics(config.owner).observe(larkCallback ? 'lark' : 'feishu', performance.now() - started);
        }
        if (event.kind === 'attachment' && readAttachment) {
          await attachFromChannel(channel, collaboration.workspace, event, async () => {
            const text = await readAttachment(event.id, event.key);
            return text === undefined ? undefined : { name: event.name, text };
          });
        }
        reply(response, 200, {});
        return;
      }
      if (url.pathname.startsWith('/v1/device/')) {
        if (request.method !== 'POST') throw new RequestError(405, 'Expected POST');
        if (!auth.startsWith('Bearer ')) throw new RequestError(401, 'Device authentication required');
        const result = deviceOperation(store, auth.slice(7), url.pathname, await jsonObject(request, url.pathname.endsWith('/finish') ? maxDeviceFinishBytes :
          url.pathname === '/v1/device/claim' ? maxDeviceClaimBytes : undefined), expireRuns, config.memory);
        reply(response, result.status, result.body);
        return;
      }
      if (url.pathname === '/v1/pairings/redeem' && request.method === 'POST') {
        const data = await jsonObject(request);
        const code = requiredText(data.code, 'code', 32);
        const name = requiredText(data.name, 'name', 128);
        const token = requiredText(data.token, 'device credential', 43);
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new RequestError(400, 'Invalid device credential');
        const pending = store.requestMobilePairing(code, name, token, Date.now());
        if (!pending) throw new RequestError(404, 'Pairing code is invalid or expired');
        reply(response, 202, pending);
        return;
      }
      if (url.pathname === '/v1/pairings/status' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id || !/^[a-f0-9-]{36}$/.test(id) || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) {
          throw new RequestError(404, 'Pairing request unavailable');
        }
        const state = store.mobilePairingState(id, auth.slice(7), Date.now());
        if (!state) throw new RequestError(404, 'Pairing request unavailable');
        reply(response, 200, { state });
        return;
      }
      const supplied = Buffer.from(auth);
      const publicGateway = request.headers['x-blazar-public-gateway'] === '1';
      const admin = !publicGateway && supplied.length === expected.length && timingSafeEqual(supplied, expected);
      const mobileToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const mobile = admin ? undefined : store.mobileIdentity(mobileToken);
      const owner = admin ? config.owner : mobile?.owner;
      if (!owner) throw new RequestError(401, 'Authentication required');
      const canReadTask = (taskId: string, resultVersion?: number) => {
        const app = store.appEvidence(taskId);
        const personal = store.personalEvidence(taskId);
        if (!app && !personal.length) return true;
        const task = store.get(owner, taskId);
        if (!task) return false;
        if (app && !admin && (!mobile || task.status !== 'succeeded' ||
            resultVersion === undefined || resultVersion !== task.version ||
            !store.canReadSharedResult(mobile.id, taskId, resultVersion))) return false;
        return (!app || Boolean(config.memory?.resolveAppEvidence(owner, task.workspace, app))) &&
          (!personal.length || Boolean(config.memory?.resolvePersonalEvidence(owner, task.workspace, personal)));
      };
      const protectedTaskLabel = 'Application-backed task';
      const taskResponse = (task: Task) => canReadTask(task.id) ? task : {
        ...task, ...(!admin && store.appEvidence(task.id) && { goal: protectedTaskLabel }), result: null,
      };
      if (!admin && (url.pathname.startsWith('/v1/admin/') || url.pathname === '/v1/pairings' ||
          url.pathname.startsWith('/v1/app-connections') || url.pathname.startsWith('/v1/memory'))) {
        throw new RequestError(403, 'Administrator required');
      }
      if (url.pathname === '/v1/mobile/push' && request.method === 'POST') {
        if (admin) throw new RequestError(403, 'Paired mobile client required');
        const { deviceToken } = await jsonObject(request);
        if (deviceToken !== null && (typeof deviceToken !== 'string' ||
            !/^(?:[a-f0-9]{2}){1,256}$/.test(deviceToken))) {
          throw new RequestError(400, 'Invalid APNs device token');
        }
        if (deviceToken !== null && !config.pushEnabled) throw new RequestError(503, 'Push is not configured');
        if (!store.registerPush(mobileToken, deviceToken)) throw new RequestError(409, 'Unable to register push on this pairing');
        reply(response, 200, { enabled: deviceToken !== null });
        return;
      }
      const taskLinks = /^\/v1\/admin\/tasks\/([a-f0-9-]{36})\/links(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
      if (taskLinks && request.method === 'GET' && !taskLinks[2]) {
        if (!store.get(owner, taskLinks[1])) throw new RequestError(404, 'Task not found');
        reply(response, 200, { links: store.taskChannels(owner, taskLinks[1]) });
        return;
      }
      if (taskLinks?.[2] && request.method === 'DELETE') {
        if (!store.unlinkTaskChannel(owner, taskLinks[1], taskLinks[2])) throw new RequestError(404, 'Task conversation link not found');
        reply(response, 200, { removed: true });
        return;
      }
      if (url.pathname === '/v1/admin/task-links' && request.method === 'POST') {
        const data = await jsonObject(request);
        const id = requiredText(data.taskId, 'task ID', 36);
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new RequestError(400, 'Invalid task ID');
        const link = store.createTaskLink(owner, id, Date.now());
        if (!link) throw new RequestError(404, 'Task not found');
        reply(response, 201, link);
        return;
      }
      if (url.pathname === '/v1/admin/audit-export' && request.method === 'GET') {
        const cursor = store.eventCursor();
        const rawAfter = url.searchParams.get('after') ?? '0';
        const rawThrough = url.searchParams.get('through') ?? String(cursor);
        const after = Number(rawAfter);
        const through = Number(rawThrough);
        if (!/^\d+$/.test(rawAfter) || !/^\d+$/.test(rawThrough) ||
            !Number.isSafeInteger(after) || !Number.isSafeInteger(through) || after > through || through > cursor) {
          throw new RequestError(400, 'Invalid audit export range');
        }
        const page = store.events(owner, after, through);
        reply(response, 200, { version: 1, through, nextAfter: page.length === 100 ? page.at(-1)!.seq : null,
          events: page.map(event => ({ ...event, data: canReadTask(event.taskId) ? JSON.parse(event.data) : {} })),
        });
        return;
      }
      if (url.pathname === '/v1/admin/event-retention' && request.method === 'POST') {
        const data = await jsonObject(request);
        const before = data.before;
        if (typeof before !== 'number' || !Number.isSafeInteger(before) || before <= 0 || before > Date.now()) {
          throw new RequestError(400, 'Invalid progress retention cutoff');
        }
        reply(response, 200, { removed: store.pruneProgressEvents(before) });
        return;
      }
      if (url.pathname === '/v1/admin/metrics' && request.method === 'GET') {
        const channels = [
          ['weixin', config.streamChannels?.weixin, true],
          ['feishu', config.feishu, Boolean(config.readFeishuAttachment)],
          ['lark', config.lark, Boolean(config.readLarkAttachment)],
          ['wecom', config.streamChannels?.wecom, true],
          ['dingtalk', config.streamChannels?.dingtalk, true],
          ['qq', config.qq, true],
        ] as const;
        reply(response, 200, {
          ...ownerMetrics(owner).snapshot(), ...store.metrics(owner, Date.now()),
          channels: channels.map(([id, channel, outbound]) => ({
            id, workspace: channel?.workspace ?? null, inbound: Boolean(channel), outbound: Boolean(channel && outbound),
            ...((channel && 'health' in channel && channel.health) && { health: channel.health() }),
          })),
        });
        return;
      }
      if (config.memory && await handleApplicationWrites(request, response, url, owner, config.memory,
        config.applicationWrites ?? [], mobile ? {
          kind: 'mobile', id: mobile.id, authorized: () => store.mobileIdentity(mobileToken)?.id === mobile.id,
        } : { kind: 'admin', hasClient: id => store.mobileClients(owner).some(client => client.id === id) })) return;
      if (admin && await handleAdmin(request, response, url, owner, store, workerRegistry)) return;
      const shareResult = /^\/v1\/tasks\/([a-f0-9-]{36})\/share-result$/.exec(url.pathname);
      if (shareResult && (request.method === 'GET' || request.method === 'POST')) {
        if (!admin) throw new RequestError(403, 'Administrator required');
        const task = store.get(owner, shareResult[1]);
        if (!task || !store.appEvidence(task.id)) throw new RequestError(404, 'Application-backed task not found');
        if (request.method === 'POST') {
          const data = await jsonObject(request);
          const current = store.get(owner, task.id)!;
          const clientId = requiredText(data.clientId, 'mobile client ID', 36);
          if (typeof data.enabled !== 'boolean') throw new RequestError(400, 'Invalid result sharing option');
          if (data.enabled && (data.expectedVersion !== current.version || current.status !== 'succeeded' || !canReadTask(task.id))) {
            throw new RequestError(409, 'The current task version is not available for sharing');
          }
          if (!store.shareTaskResult(owner, task.id, current.version, clientId, data.enabled)) {
            throw new RequestError(404, 'Paired mobile client not found');
          }
        }
        reply(response, 200, { clients: store.resultGrants(owner, task.id) });
        return;
      }
      const saveTaskMemory = /^\/v1\/tasks\/([a-f0-9-]{36})\/remember-result$/.exec(url.pathname);
      if (saveTaskMemory && request.method === 'POST') {
        if (!admin) throw new RequestError(403, 'Administrator required');
        if (!config.memory) throw new RequestError(503, 'Memory is unavailable');
        const data = await jsonObject(request);
        const task = store.get(owner, saveTaskMemory[1]);
        if (!task) throw new RequestError(404, 'Task not found');
        if (data.expectedVersion !== task.version || task.status !== 'succeeded' || store.appEvidence(task.id) || store.personalEvidence(task.id).length ||
            !task.result?.trim() || task.result.length > 16_000 || /^\/(observe|click|write) /.test(task.goal)) {
          throw new RequestError(409, 'This task version does not have a result eligible for memory');
        }
        reply(response, 200, { id: config.memory.rememberTaskResult(owner, task.workspace, task.id, task.version, task.result) });
        return;
      }
      const timeline = /^\/v1\/tasks\/([a-f0-9-]{36})\/timeline$/.exec(url.pathname);
      if (request.method === 'GET' && timeline) {
        if (!canReadTask(timeline[1])) throw new RequestError(404, 'Task timeline not found');
        const raw = url.searchParams.get('before');
        const before = raw === null ? undefined : Number(raw);
        if (before !== undefined && (!/^\d+$/.test(raw!) || !Number.isSafeInteger(before) || before < 1)) {
          throw new RequestError(400, 'Invalid timeline cursor');
        }
        const page = store.timeline(owner, timeline[1], before);
        if (!page) throw new RequestError(404, 'Task not found');
        reply(response, 200, page);
        return;
      }
      const diff = /^\/v1\/artifacts\/([a-f0-9-]{36})\/diff$/.exec(url.pathname);
      if (diff && request.method === 'GET') {
        const base = url.searchParams.get('base');
        if (!base || !/^[a-f0-9-]{36}$/.test(base)) throw new RequestError(400, 'Invalid base artifact ID');
        const previous = store.artifact(owner, base);
        const current = store.artifact(owner, diff[1]);
        if (!previous || !current || previous.mime || current.mime || previous.taskId !== current.taskId ||
            !canReadTask(current.taskId, current.version ?? undefined) || !canReadTask(previous.taskId, previous.version ?? undefined)) {
          throw new RequestError(404, 'Comparable artifacts not found');
        }
        const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
        reply(response, 200, { text: artifactDiff(previous.name, decode(previous.content), current.name, decode(current.content)) });
        return;
      }
      const attachmentPath = /^\/v1\/tasks\/([a-f0-9-]{36})\/attachments\/([0-3])$/.exec(url.pathname);
      if (request.method === 'GET' && attachmentPath) {
        if (!canReadTask(attachmentPath[1])) throw new RequestError(404, 'Task attachment not found');
        const attachment = store.taskAttachment(owner, attachmentPath[1], Number(attachmentPath[2]));
        if (!attachment) throw new RequestError(404, 'Task attachment not found');
        reply(response, 200, attachment);
        return;
      }
      const artifactPath = /^\/v1\/artifacts\/([a-f0-9-]{36})(\/image)?$/.exec(url.pathname);
      if (request.method === 'GET' && artifactPath) {
        const file = store.artifact(owner, artifactPath[1]);
        if (!file || !canReadTask(file.taskId, file.version ?? undefined)) throw new RequestError(404, 'Artifact not found');
        if (artifactPath[2]) {
          if (file.mime !== 'image/png') throw new RequestError(404, 'Window image not found');
          reply(response, 200, { png: Buffer.from(file.content).toString('base64') });
          return;
        }
        response.writeHead(200, {
          'Content-Type': file.mime ?? 'text/plain; charset=utf-8',
          'Content-Length': String(file.content.byteLength),
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name.toWellFormed())
            .replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16)),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ETag: '"' + file.sha256 + '"',
        });
        response.end(file.content);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        const snapshot = store.snapshot(owner);
        const protectedTasks = new Set(store.appEvidenceTasks(owner));
        const personalTasks = new Set(store.personalEvidenceTasks(owner));
        const unavailablePersonal = new Set(snapshot.tasks.filter(task => personalTasks.has(task.id) &&
          !config.memory?.resolvePersonalEvidence(owner, task.workspace, store.personalEvidence(task.id))).map(task => task.id));
        const restricted = new Set([...unavailablePersonal, ...[...protectedTasks].filter(taskId => !canReadTask(taskId))]);
        reply(response, 200, { ...snapshot,
          tasks: snapshot.tasks.map(task => ({
            ...task,
            ...(protectedTasks.has(task.id) && { usesAppMemory: true,
              ...(!admin && { goal: protectedTaskLabel }),
              ...(admin && restricted.has(task.id) && { appMemoryUnavailable: true }),
            }),
            ...(personalTasks.has(task.id) && { usesPersonalMemory: true,
              ...(unavailablePersonal.has(task.id) && { personalMemoryUnavailable: true }),
            }),
            ...(restricted.has(task.id) && !canReadTask(task.id, task.version) && { result: null }),
          })),
          artifacts: snapshot.artifacts.filter(item => !restricted.has(String(item.taskId)) ||
            canReadTask(String(item.taskId), typeof item.version === 'number' ? item.version : undefined)),
          criteria: snapshot.criteria.filter(item => admin || !protectedTasks.has(String(item.taskId))),
          workflowSteps: snapshot.workflowSteps.filter(item => admin ||
            (!protectedTasks.has(String(item.taskId)) && !protectedTasks.has(String(item.predecessorId)))),
          attachments: snapshot.attachments.filter(item => !restricted.has(String(item.taskId))),
          progress: snapshot.progress.filter(item => !restricted.has(String(item.taskId))),
          approvals: snapshot.approvals.filter(item => !restricted.has(String(item.taskId))),
          desktopTargets: store.desktopTargets(owner),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/stream') {
        const raw = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
        const cursor = Number(raw);
        if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(cursor)) {
          throw new RequestError(400, 'Invalid event cursor');
        }
        const replayThrough = store.eventCursor();
        const metrics = ownerMetrics(owner);
        if (cursor < store.eventReplayFloor() || cursor > replayThrough) {
          metrics.recordStream('resnapshotRequired');
          throw new RequestError(409, 'Event cursor requires a new snapshot');
        }
        await streamTaskEvents(store, owner, cursor, response, () => admin || store.mobileOwner(mobileToken) === owner,
          url.searchParams.get('once') === '1', canReadTask, replayThrough, metrics);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/workflows') {
        const key = requiredText(request.headers['idempotency-key'], 'Idempotency-Key', 128);
        const data = await jsonObject(request);
        if (!admin && store.mobileOwner(mobileToken) !== owner) throw new RequestError(401, 'Authentication required');
        reply(response, 202, submitWorkflow(store, config.memory, owner, key, data, admin, mobile?.id));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/conversation') {
        const key = requiredText(request.headers['idempotency-key'], 'Idempotency-Key', 128);
        const data = await jsonObject(request);
        if (!admin && store.mobileOwner(mobileToken) !== owner) throw new RequestError(401, 'Authentication required');
        if (data.usePersonalMemory !== undefined && typeof data.usePersonalMemory !== 'boolean') {
          throw new RequestError(400, 'Invalid personal memory option');
        }
        const input: RouteRequest = {
          workspace: requiredText(data.workspace, 'workspace', 128),
          text: requiredText(data.text, 'text', 32_000),
          ...(data.usePersonalMemory === true ? { usePersonalMemory: true } : {}),
        };
        const result = await routeConversation({
          owner, caller: mobile?.id ?? 'admin', admin, key, input,
          metrics: ownerMetrics(owner), authorized: () => admin || store.mobileOwner(mobileToken) === owner, canReadTask,
        });
        reply(response, result.status, result.body);
        return;
      }
      const taskCommand = /^\/v1\/tasks\/([a-f0-9-]+)\/commands$/.exec(url.pathname);
      if (request.method === 'POST' && (url.pathname === '/v1/events' || taskCommand)) {
        const key = requiredText(request.headers['idempotency-key'], 'Idempotency-Key', 128);
        const data = await jsonObject(request);
        if (!admin && store.mobileOwner(mobileToken) !== owner) throw new RequestError(401, 'Authentication required');
        if (!taskCommand) {
          const task = submitTask(store, config.memory, owner, key, data, admin, mobile?.id);
          ownerMetrics(owner).observe('event', performance.now() - started);
          reply(response, 202, taskResponse(task));
          return;
        }
        const taskId = taskCommand[1];
        const current = store.get(owner, taskId);
        if (!current) throw new RequestError(404, 'Task not found');
        const version = data.expectedVersion;
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
          throw new RequestError(400, 'Invalid expectedVersion');
        }
        const action = data.action;
        let command: Parameters<TaskStore['command']>[3];
        if (action === 'append') command = { action, text: requiredText(data.text, 'text', 32_000) };
        else if (action === 'cancel' || action === 'pause' || action === 'resume' || action === 'retry' || action === 'accept_result' || action === 'reject_result') command = { action };
        else if (action === 'approve' || action === 'deny') {
          command = { action, approvalId: requiredText(data.approvalId, 'approval ID', 36) };
        } else throw new RequestError(400, 'Invalid action');
        if (['approve', 'accept_result', 'append', 'resume', 'retry'].includes(command.action)) {
          if (!workerMemoryAvailable(store, config.memory, owner, current.workspace, taskId)) {
            flushStopNotifications();
            throw new RequestError(409, 'Task memory access changed');
          }
        }
        const result = store.command(owner, taskId, version, command, key, mobile?.id);
        if (result) {
          if (action === 'pause' || action === 'cancel' || action === 'append') devices.flushStops();
          reply(response, 200, taskResponse(result));
        } else {
          const task = store.get(owner, taskId);
          reply(response, 409, { error: 'Task state changed or command unavailable',
            task: task && taskResponse(task) });
        }
        return;
      }
      if (config.memory && await handleMemory(request, response, url, owner, config.memory, admission,
        config.documents, config.answerMemory, config.draftMemory, admin ? config.applicationWrites : undefined)) {
        if (request.method !== 'GET') flushStopNotifications();
        return;
      }
      throw new RequestError(404, 'Route not found');
    } catch (error) {
      if (response.headersSent) {
        response.end();
      } else if (error instanceof RequestError || error instanceof ConversationError) {
        reply(response, error.status, { error: error.message });
      } else if (error instanceof InvalidWorkflow) {
        reply(response, 400, { error: error.message });
      } else if (error instanceof IdempotencyConflict || error instanceof StaleRoutingEvidence) {
        reply(response, 409, { error: error.message });
      } else {
        reply(response, 500, { error: 'Internal server error' });
      }
    }
  });

  devices.attach(server, (token, path, body) => deviceOperation(store, token, path, body, expireRuns, config.memory));
  return Object.assign(server, { closeDeviceSockets: devices.closeDeviceSockets, flushStopNotifications, expireRuns });
}
