import { invokeApplicationAction, type ActionBackend } from '../../../packages/apps/actions.ts';
import type { AppWriteRepository } from '../persistence/app-write-repository.ts';
import { RequestError } from '../protocol/request.ts';

export async function confirmApplicationWrite(
  writes: AppWriteRepository,
  owner: string,
  id: string,
  definitionRevision: string,
  backends: readonly ActionBackend[],
  signal: AbortSignal,
) {
  const proposal = writes.get(owner, id);
  if (!proposal) throw new RequestError(404, 'Application write proposal not found');
  if (proposal.status !== 'pending') return { status: proposal.status };
  signal.throwIfAborted();
  if (!writes.claim(owner, id, definitionRevision)) {
    const current = writes.get(owner, id);
    if (current && current.status !== 'pending') return { status: current.status };
    throw new RequestError(409, 'Application write approval expired or its access or configuration changed');
  }
  try {
    const result = await invokeApplicationAction({
      connectionId: proposal.connection, capability: proposal.capability,
      effect: 'write', invocationId: id, input: proposal.input,
    }, backends, async backend => writes.selectBackend(owner, id, backend.id), signal);
    const status = result.status === 'outcome-unknown' ? 'outcome_unknown'
      : result.status === 'unavailable-before-dispatch' ? 'unavailable' : result.status;
    writes.finish(owner, id, status);
    return { status };
  } catch (error) {
    writes.finish(owner, id, 'outcome_unknown');
    throw error;
  }
}
