import type { DesktopAppControls, RunOutcome, WorkerConfiguration } from '../../../packages/protocol/task.ts';
import type { TaskStore } from '../store.ts';
import type { MemoryStore } from '../memory.ts';
import { RequestError, requiredText } from '../protocol/request.ts';
import { workerMemoryAvailable } from './task-memory.ts';

type DeviceTasks = Pick<TaskStore, 'deviceForToken' | 'reportInterruption' | 'recordDesktopApps' | 'recordDeviceWorker' |
  'recordDeviceActivity' | 'claim' | 'clearInterruption' | 'appEvidence' | 'personalEvidence' | 'runTaskId' |
  'runEvidenceStopping' | 'rejectRunEvidence' | 'requestRunEvidenceStop' | 'runInputArtifact' | 'acknowledgeStop' |
  'steering' | 'progress' | 'requestApproval' | 'consumeApproval' | 'approvalForRun' | 'renew' | 'finish'>;
type DeviceMemory = Pick<MemoryStore, 'resolveAppEvidence' | 'resolvePersonalEvidence' | 'recordWorkerAppUsage'>;

export function deviceOperation(store: DeviceTasks, bearer: string, pathname: string, data: Record<string, unknown>,
                                expireRuns: (now: number) => number, memory?: DeviceMemory) {
  const device = store.deviceForToken(bearer);
  if (!device) throw new RequestError(401, 'Device authentication required');
  const now = Date.now();
  const leaseMs = 45_000;
  if (pathname === '/v1/device/interrupted') {
    const runId = requiredText(data.runId, 'run ID', 36);
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new RequestError(400, 'Invalid run ID');
    store.reportInterruption(device.id, runId, now);
    return { status: 200, body: { recorded: true } };
  }
  if (pathname === '/v1/device/claim') {
    if (data.capability !== undefined && data.capability !== 'document.preview' && data.capability !== 'agent.acp' && data.capability !== 'computer.observe') {
      throw new RequestError(400, 'Unknown capability');
    }
    const key = data.requestId;
    if (key !== undefined && (typeof key !== 'string' || !/^[a-f0-9-]{36}$/.test(key))) {
      throw new RequestError(400, 'Invalid claim request ID');
    }
    const platform = data.platform === undefined ? undefined : requiredText(data.platform, 'device platform', 32);
    let worker: WorkerConfiguration | undefined;
    if (data.worker !== undefined) {
      if (data.capability !== 'agent.acp' || !data.worker || typeof data.worker !== 'object' || Array.isArray(data.worker)) {
        throw new RequestError(400, 'Unexpected Worker metadata');
      }
      const reported = data.worker as Record<string, unknown>;
      const protocol = requiredText(reported.protocol, 'Worker protocol', 16);
      if (!['acp', 'codex', 'claude', 'pi', 'aider', 'jsonl'].includes(protocol)) {
        throw new RequestError(400, 'Unknown Worker protocol');
      }
      const label = requiredText(reported.label, 'Worker label', 128);
      if (/[\x00-\x1f\x7f]/.test(label)) throw new RequestError(400, 'Invalid Worker label');
      worker = { label, protocol };
      if (reported.adapterVersion !== undefined || reported.revision !== undefined) {
        if (reported.adapterVersion !== 1 || typeof reported.revision !== 'string' ||
            !/^[a-f0-9]{64}$/.test(reported.revision)) throw new RequestError(400, 'Invalid Worker revision');
        worker.adapterVersion = reported.adapterVersion;
        worker.revision = reported.revision;
      }
    }
    let desktopApps: string[] | undefined;
    if (data.desktopApps !== undefined) {
      if (data.capability !== 'computer.observe' || !Array.isArray(data.desktopApps) || data.desktopApps.length > 25 ||
          data.desktopApps.some(alias => typeof alias !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(alias))) {
        throw new RequestError(400, 'Invalid desktop application aliases');
      }
      desktopApps = [...new Set(data.desktopApps as string[])].sort();
    }
    let desktopPermissions: Record<string, string> | undefined;
    if (data.desktopPermissions !== undefined) {
      if (!desktopApps || !data.desktopPermissions || typeof data.desktopPermissions !== 'object' ||
          Array.isArray(data.desktopPermissions)) throw new RequestError(400, 'Invalid desktop permissions');
      const states = data.desktopPermissions as Record<string, unknown>;
      desktopPermissions = {};
      for (const name of ['accessibility', 'screen_recording', 'automation']) {
        const state = states[name];
        if (typeof state !== 'string' || !/^[a-z_]{1,32}$/.test(state)) {
          throw new RequestError(400, 'Invalid desktop permission state');
        }
        desktopPermissions[name] = state;
      }
    }
    let desktopControls: DesktopAppControls[] | undefined;
    if (data.desktopControls !== undefined) {
      if (!desktopApps || !Array.isArray(data.desktopControls) || data.desktopControls.length !== desktopApps.length) {
        throw new RequestError(400, 'Invalid desktop controls');
      }
      const remaining = new Set(desktopApps);
      desktopControls = data.desktopControls.map(entry => {
        if (!entry || typeof entry !== 'object' || !remaining.delete(entry.alias) ||
            typeof entry.visual !== 'boolean' || !Array.isArray(entry.buttons) || entry.buttons.length > 25 ||
            entry.buttons.some((label: unknown) => typeof label !== 'string' || !label.trim()
              || label.length > 120 || /[\x00-\x1f\x7f]/.test(label))) {
          throw new RequestError(400, 'Invalid desktop controls');
        }
        return { alias: entry.alias, visual: entry.visual, buttons: [...new Set<string>(entry.buttons)] };
      });
    }
    store.recordDesktopApps(device.id, desktopApps, desktopPermissions, desktopControls);
    store.recordDeviceWorker(device.id, worker);
    store.recordDeviceActivity(device.id, now, data.capability, platform);
    expireRuns(now);
    const claim = store.claim(device.owner, device.workspace, device.id, now, leaseMs,
      data.capability === 'document.preview' ? '/preview ' : data.capability === 'computer.observe' ? '/observe ' : '',
      data.capability === 'agent.acp' ? '/preview ' : '', key, worker, desktopApps, data.capability === 'agent.acp');
    if (!claim) {
      store.clearInterruption(device.id);
      return { status: 200, body: { assignment: null } };
    }
    const { replayed, ...assignment } = claim;
    const personal = assignment.memoryInputs?.map(({ id, version }) => ({ id, version })) ?? [];
    const app = store.appEvidence(assignment.task.id);
    if (personal.length || app) {
      const personalEvidence = personal.length ? memory?.resolvePersonalEvidence(device.owner, device.workspace, personal) : [];
      const appEvidence = app ? memory?.resolveAppEvidence(device.owner, device.workspace, app) : [];
      if (data.capability !== 'agent.acp' || !memory || !personalEvidence || !appEvidence) {
        if (replayed) store.requestRunEvidenceStop(assignment.run.id, device.id);
        else store.rejectRunEvidence(assignment.run.id, device.id);
        return { status: 200, body: { assignment: null } };
      }
      if (appEvidence.length) memory.recordWorkerAppUsage(device.workspace, assignment.task.id, assignment.run.id,
        [...new Set(appEvidence.map(input => input.connection))]);
      assignment.memoryInputs = [...personalEvidence, ...appEvidence.map(({ id, body, version }) => ({ id, body, version }))];
    }
    store.clearInterruption(device.id);
    return { status: 200, body: { assignment, leaseRemainingMs: Math.max(0, assignment.run.expires - Date.now()) } };
  }
  const run = /^\/v1\/device\/runs\/([a-f0-9-]{36})\/(renew|finish|stopped|request-approval|approval|consume-approval|progress|input-artifact|steer)$/.exec(pathname);
  if (!run) throw new RequestError(404, 'Route not found');
  if (['renew', 'finish', 'progress', 'request-approval', 'approval', 'consume-approval', 'input-artifact', 'steer'].includes(run[2])) {
    const taskId = store.runTaskId(run[1], device.id);
    if (store.runEvidenceStopping(run[1]) ||
        (taskId && !workerMemoryAvailable(store, memory, device.owner, device.workspace, taskId))) {
      if (run[2] === 'finish') store.rejectRunEvidence(run[1], device.id);
      else store.requestRunEvidenceStop(run[1], device.id);
      return { status: 409, body: { accepted: false } };
    }
  }
  if (run[2] === 'input-artifact') {
    const artifactId = requiredText(data.artifactId, 'artifact ID', 36);
    if (!/^[a-f0-9-]{36}$/.test(artifactId)) throw new RequestError(400, 'Invalid artifact ID');
    const artifact = store.runInputArtifact(run[1], device.id, artifactId, now);
    if (!artifact) throw new RequestError(404, 'Run input artifact not found');
    const { content, ...identity } = artifact;
    return { status: 200, body: { ...identity, text: Buffer.from(content).toString('utf8') } };
  }
  if (run[2] === 'stopped') {
    const accepted = store.acknowledgeStop(run[1], device.id, now);
    return { status: accepted ? 200 : 409, body: { accepted } };
  }
  if (run[2] === 'steer') {
    const version = data.appliedVersion;
    if (version !== undefined && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)) {
      throw new RequestError(400, 'Invalid instruction version');
    }
    const result = store.steering(run[1], device.id, now, version);
    return { status: result ? 200 : 409, body: result ?? { accepted: false } };
  }
  if (run[2] === 'progress') {
    const seq = data.seq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || seq > 10_000) {
      throw new RequestError(400, 'Invalid progress sequence');
    }
    const accepted = store.progress(run[1], device.id, now, seq, requiredText(data.message, 'message', 1_024));
    return { status: accepted ? 200 : 409, body: { accepted } };
  }
  if (run[2] === 'request-approval') {
    const approval = store.requestApproval(run[1], device.id, requiredText(data.summary, 'summary', 4_000), now);
    return { status: approval ? 200 : 409, body: { approval: approval ?? null } };
  }
  if (run[2] === 'consume-approval') {
    const accepted = store.consumeApproval(run[1], device.id, requiredText(data.approvalId, 'approval ID', 36), now);
    return { status: accepted ? 200 : 409, body: { accepted } };
  }
  if (run[2] === 'approval') {
    const approval = store.approvalForRun(run[1], device.id, requiredText(data.approvalId, 'approval ID', 36), now);
    return { status: approval ? 200 : 404, body: { decision: approval?.decision ?? null } };
  }
  if (run[2] === 'renew') {
    store.recordDeviceActivity(device.id, now);
    const expires = store.renew(run[1], device.id, now, leaseMs);
    if (expires === undefined) return { status: 409, body: { renewed: false } };
    return { status: 200, body: { renewed: true, leaseRemainingMs: Math.max(0, expires - Date.now()) } };
  }
  if (data.status !== 'succeeded' && data.status !== 'failed' && data.status !== 'waiting_user') {
    throw new RequestError(400, 'Invalid outcome status');
  }
  let artifact: RunOutcome['artifact'];
  if (data.artifact !== undefined) {
    if (data.status !== 'succeeded' || !data.artifact || typeof data.artifact !== 'object' || Array.isArray(data.artifact)) {
      throw new RequestError(400, 'Invalid artifact');
    }
    const file = data.artifact as Record<string, unknown>;
    const name = requiredText(file.name, 'artifact name', 128);
    if (typeof file.text !== 'string') throw new RequestError(400, 'Invalid artifact content');
    if (file.mime === 'image/png') {
      if (file.text.length > 1_333_336) throw new RequestError(400, 'Window image is too large');
      const png = Buffer.from(file.text, 'base64');
      if (png.length < 33 || png.length > 1_000_000 || png.toString('base64') !== file.text ||
          png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(8) !== 13 ||
          png.toString('ascii', 12, 16) !== 'IHDR' || !png.readUInt32BE(16) || !png.readUInt32BE(20) ||
          png.readUInt32BE(16) * png.readUInt32BE(20) > 16_000_000) {
        throw new RequestError(400, 'Invalid window image');
      }
      artifact = { name, text: file.text, mime: file.mime };
    } else {
      if (file.mime !== undefined || Buffer.byteLength(file.text) > 32_000) {
        throw new RequestError(400, 'Invalid artifact content');
      }
      artifact = { name, text: file.text };
    }
  }
  const accepted = store.finish(run[1], device.id, now, {
    status: data.status,
    result: requiredText(data.result, 'result', 32_000),
    artifact,
  });
  return { status: accepted ? 200 : 409, body: { accepted } };
}
