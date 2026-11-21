import type { IncomingMessage, ServerResponse } from 'node:http';
import { workerCatalog } from '../../../packages/workers/registry.ts';
import { RequestError, requiredText } from '../protocol/request.ts';
import type { TaskStore } from '../store.ts';
import { jsonObject, reply } from './json.ts';

export async function handleAdmin(request: IncomingMessage, response: ServerResponse, url: URL,
                                  owner: string, store: TaskStore): Promise<boolean> {
  if (url.pathname === '/v1/pairings' && request.method === 'POST') {
    reply(response, 201, store.createPairing(owner, Date.now()));
    return true;
  }
  if (url.pathname === '/v1/admin/mobile-pairings' && request.method === 'GET') {
    reply(response, 200, { requests: store.pendingMobilePairings(owner, Date.now()) });
    return true;
  }
  const pairingDecision = /^\/v1\/admin\/mobile-pairings\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (pairingDecision && request.method === 'POST') {
    const { approve } = await jsonObject(request);
    if (typeof approve !== 'boolean') throw new RequestError(400, 'Invalid pairing decision');
    if (!store.decideMobilePairing(owner, pairingDecision[1], approve, Date.now())) {
      throw new RequestError(404, 'Pairing request unavailable');
    }
    reply(response, 200, { approved: approve });
    return true;
  }
  if (url.pathname === '/v1/admin/mobile-clients' && request.method === 'GET') {
    reply(response, 200, { clients: store.mobileClients(owner) });
    return true;
  }
  const revokeMobile = /^\/v1\/admin\/mobile-clients\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (revokeMobile && request.method === 'DELETE') {
    if (!store.revokeMobile(owner, revokeMobile[1])) throw new RequestError(404, 'Mobile client not found');
    reply(response, 200, { revoked: true });
    return true;
  }
  if (url.pathname === '/v1/admin/worker-policies') {
    if (request.method === 'GET') {
      reply(response, 200, { policies: store.workspaceWorkerPolicies(owner) });
      return true;
    }
    if (request.method === 'PUT') {
      const data = await jsonObject(request);
      const workspace = requiredText(data.workspace, 'workspace', 128);
      const protocols = data.protocols;
      const supported = new Set([...workerCatalog().map(worker => worker.protocol), 'jsonl']);
      if (protocols !== null && (!Array.isArray(protocols) || protocols.length > supported.size ||
          protocols.some(protocol => typeof protocol !== 'string' || !supported.has(protocol)))) {
        throw new RequestError(400, 'Invalid Worker protocols');
      }
      const maxConcurrent = data.maxConcurrent;
      if (maxConcurrent !== undefined && (protocols === null || typeof maxConcurrent !== 'number' ||
          !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 100)) {
        throw new RequestError(400, 'Invalid workspace Worker concurrency limit');
      }
      const runLimitSeconds = data.runLimitSeconds;
      if (runLimitSeconds !== undefined && (protocols === null || typeof runLimitSeconds !== 'number' ||
          !Number.isSafeInteger(runLimitSeconds) || runLimitSeconds < 30 || runLimitSeconds > 600)) {
        throw new RequestError(400, 'Invalid workspace Worker run time limit');
      }
      store.setWorkspaceWorkerPolicy(owner, workspace, protocols === null ? null : [...new Set(protocols)].sort(),
        maxConcurrent, runLimitSeconds);
      store.updateDeviceReadiness(Date.now());
      reply(response, 200, { policies: store.workspaceWorkerPolicies(owner) });
      return true;
    }
  }
  if (url.pathname === '/v1/admin/workers' && request.method === 'GET') {
    reply(response, 200, { presets: workerCatalog(), extensionProtocols: ['acp', 'jsonl'] });
    return true;
  }
  if (url.pathname === '/v1/admin/devices') {
    if (request.method === 'GET') {
      reply(response, 200, { devices: store.devices(owner) });
      return true;
    }
    if (request.method === 'POST') {
      const data = await jsonObject(request);
      const name = requiredText(data.name, 'name', 128);
      const workspace = requiredText(data.workspace, 'workspace', 128);
      reply(response, 201, store.registerDevice(owner, name, workspace));
      return true;
    }
  }
  const revoke = /^\/v1\/admin\/devices\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (request.method === 'PATCH' && revoke) {
    const data = await jsonObject(request);
    if (typeof data.paused !== 'boolean') throw new RequestError(400, 'Expected paused to be a boolean');
    if (!store.setDevicePaused(owner, revoke[1], data.paused)) throw new RequestError(404, 'Active device not found');
    reply(response, 200, { paused: data.paused });
    return true;
  }
  if (request.method === 'DELETE' && revoke) {
    if (!store.revokeDevice(owner, revoke[1])) throw new RequestError(404, 'Active device not found');
    reply(response, 200, { revoked: true });
    return true;
  }
  return false;
}
