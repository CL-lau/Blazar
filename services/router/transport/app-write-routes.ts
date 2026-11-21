import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfiguredApplicationWrite } from '../../../packages/apps/config.ts';
import { confirmApplicationWrite } from '../application/app-write.ts';
import type { MemoryStore } from '../memory.ts';
import { RequestError, requiredText } from '../protocol/request.ts';
import { jsonObject, reply } from './json.ts';

export async function handleApplicationWrites(
  request: IncomingMessage, response: ServerResponse, url: URL, owner: string, memory: MemoryStore,
  definitions: readonly ConfiguredApplicationWrite[],
) {
  const writes = memory.appWrites;
  const definitionFor = (connection: string, workspace: string, capability: string) => {
    const active = memory.connection(owner, connection, workspace);
    return definitions.find(item => item.app === active?.app && item.account === active.account && item.capability === capability);
  };
  const create = /^\/v1\/app-connections\/([a-f0-9-]{36})\/write-proposals$/.exec(url.pathname);
  if (create && request.method === 'POST') {
    const { workspace: rawWorkspace, capability: rawCapability, input } = await jsonObject(request, 16_384);
    const workspace = requiredText(rawWorkspace, 'workspace', 128);
    const capability = requiredText(rawCapability, 'capability', 128);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, 'Expected an input object');
    const connectionId = create[1];
    const definition = definitionFor(connectionId, workspace, capability);
    if (!definition) throw new RequestError(404, 'Application write capability not found');
    const expires = Date.now() + 300_000;
    const id = writes.propose(owner, workspace, { connectionId, capability, input: input as Record<string, unknown> },
      definition.revision, expires);
    if (!id) throw new RequestError(409, 'Application connection access changed');
    reply(response, 201, { id, expires, status: 'pending' });
    return true;
  }
  const proposalPath = /^\/v1\/app-write-proposals\/([a-f0-9-]{36})(\/confirm)?$/.exec(url.pathname);
  if (!proposalPath) return false;
  const [, id, confirm] = proposalPath;
  if (request.method !== (confirm ? 'POST' : 'GET')) return false;
  const proposal = writes.get(owner, id);
  if (!proposal) throw new RequestError(404, 'Application write proposal not found');
  if (!confirm) {
    const { definitionRevision, ...view } = proposal;
    reply(response, 200, view);
    return true;
  }
  const definition = definitionFor(proposal.connection, proposal.workspace, proposal.capability);
  const backends = definition ? [{ ...definition.backend, connectionId: proposal.connection }] : [];
  const result = await confirmApplicationWrite(writes, owner, id, definition?.revision ?? '', backends, AbortSignal.timeout(10_000));
  reply(response, 200, result);
  return true;
}
