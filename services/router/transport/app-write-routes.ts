import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfiguredApplicationWrite } from '../../../packages/apps/config.ts';
import { checkApplicationWrite, confirmApplicationWrite } from '../application/app-write.ts';
import type { MemoryStore } from '../memory.ts';
import { applicationWriteTimeoutMs } from '../persistence/app-write-repository.ts';
import { RequestError, requiredText } from '../protocol/request.ts';
import { jsonObject, reply } from './json.ts';

export async function handleApplicationWrites(
  request: IncomingMessage, response: ServerResponse, url: URL, owner: string, memory: MemoryStore,
  definitions: readonly ConfiguredApplicationWrite[],
  access: { kind: 'admin'; hasClient: (id: string) => boolean } |
    { kind: 'mobile'; id: string; authorized: () => boolean },
) {
  const writes = memory.appWrites;
  if (url.pathname === '/v1/app-write-proposals' && request.method === 'GET' && access.kind === 'mobile') {
    if (!access.authorized()) throw new RequestError(401, 'Authentication required');
    reply(response, 200, { proposals: writes.shared(owner, access.id) });
    return true;
  }
  const definitionFor = (connection: string, workspace: string, capability: string) => {
    const active = memory.connection(owner, connection, workspace);
    return definitions.find(item => item.app === active?.app && item.account === active.account && item.capability === capability);
  };
  const create = /^\/v1\/app-connections\/([a-f0-9-]{36})\/write-proposals$/.exec(url.pathname);
  if (create && request.method === 'GET' && access.kind === 'admin') {
    const proposals = writes.history(owner, create[1]);
    if (!proposals) throw new RequestError(404, 'Application connection not found');
    reply(response, 200, { proposals });
    return true;
  }
  if (create && request.method === 'POST' && access.kind === 'admin') {
    const { workspace: rawWorkspace, capability: rawCapability, input } = await jsonObject(request, 16_384);
    const workspace = requiredText(rawWorkspace, 'workspace', 128);
    const capability = requiredText(rawCapability, 'capability', 128);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, 'Expected an input object');
    const connectionId = create[1];
    const definition = definitionFor(connectionId, workspace, capability);
    if (!definition) throw new RequestError(404, 'Application write capability not found');
    if (Object.hasOwn(input, 'blazarInvocationId') || (definition.contract && !definition.contract.acceptsInput(input))) {
      throw new RequestError(400, 'Application write input does not match the configured capability');
    }
    const expires = Date.now() + 300_000;
    const id = writes.propose(owner, workspace, { connectionId, capability, input: input as Record<string, unknown> },
      definition.revision, expires);
    if (!id) throw new RequestError(409, 'Application connection access changed');
    reply(response, 201, { id, expires, status: 'pending' });
    return true;
  }
  const proposalPath = /^\/v1\/app-write-proposals\/([a-f0-9-]{36})(?:\/(confirm|reconcile|share|check-result))?$/.exec(url.pathname);
  if (!proposalPath) return false;
  const [, id, operation] = proposalPath;
  if (request.method !== (operation ? 'POST' : 'GET')) return false;
  const authorized = () => access.kind === 'admin' ||
    (access.authorized() && writes.shared(owner, access.id, id).length === 1);
  const proposal = writes.get(owner, id);
  if (!proposal || !authorized() || (access.kind === 'mobile' && operation && operation !== 'confirm')) throw new RequestError(404, 'Application write proposal not found');
  if (!operation) {
    const { definitionRevision, ...view } = proposal;
    if (access.kind === 'mobile') {
      const { connection, backend, ...sharedView } = view;
      const destination = memory.connection(owner, connection, proposal.workspace);
      reply(response, 200, { ...sharedView, app: destination?.app, account: destination?.account,
        inputPreview: JSON.stringify(view.input, null, 2) });
      return true;
    }
    const definition = definitionFor(proposal.connection, proposal.workspace, proposal.capability);
    const lookup = definition?.candidates.find(item => item.backend.id === proposal.backend)?.lookup;
    reply(response, 200, { ...view, reconciliation: writes.reconciliation(owner, id),
      canCheckResult: Boolean(definition && lookup && writes.canCheck(owner, id, definition.revision, lookup.id)) });
    return true;
  }
  if (operation === 'share' && access.kind === 'admin') {
    const { client: rawClient } = await jsonObject(request, 2_048);
    const client = rawClient === null ? null : requiredText(rawClient, 'mobile client ID', 36);
    if (client !== null && !access.hasClient(client)) throw new RequestError(404, 'Paired mobile client not found');
    if (!writes.share(owner, id, client) && client !== null) throw new RequestError(409, 'Proposal cannot be shared');
    reply(response, 200, { client });
    return true;
  }
  if (operation === 'reconcile') {
    const { resolution, evidence: rawEvidence } = await jsonObject(request, 4_096);
    if (resolution !== 'applied' && resolution !== 'not_applied') {
      throw new RequestError(400, 'Invalid application write resolution');
    }
    const evidence = requiredText(rawEvidence, 'external evidence', 1_024);
    writes.reconcile(owner, id, resolution, evidence);
    const reconciliation = writes.reconciliation(owner, id);
    if (reconciliation?.resolution !== resolution || reconciliation.evidence !== evidence) {
      throw new RequestError(409, 'The application write is ineligible for reconciliation or already reconciled');
    }
    reply(response, 200, reconciliation);
    return true;
  }
  const definition = definitionFor(proposal.connection, proposal.workspace, proposal.capability);
  if (operation === 'check-result') {
    const lookup = definition?.candidates.find(item => item.backend.id === proposal.backend)?.lookup;
    if (!definition || !lookup) throw new RequestError(404, 'Application outcome lookup not configured');
    const reconciliation = await checkApplicationWrite(writes, owner, id, definition.revision, lookup,
      AbortSignal.timeout(applicationWriteTimeoutMs));
    reply(response, 200, { reconciliation: reconciliation ?? null });
    return true;
  }
  const backends = definition?.candidates.map(({ backend }) => ({ ...backend, connectionId: proposal.connection })) ?? [];
  const result = await confirmApplicationWrite(writes, owner, id, definition?.revision ?? '', backends, AbortSignal.timeout(applicationWriteTimeoutMs), authorized);
  reply(response, 200, result);
  return true;
}
