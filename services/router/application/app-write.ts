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
  authorized = () => true,
) {
  const proposal = writes.get(owner, id);
  if (!proposal || !authorized()) throw new RequestError(404, 'Application write proposal not found');
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
    }, backends, async backend => authorized() && writes.selectBackend(owner, id, backend.id), signal);
    const status = result.status === 'outcome-unknown' ? 'outcome_unknown'
      : result.status === 'unavailable-before-dispatch' ? 'unavailable' : result.status;
    writes.finish(owner, id, status);
    return { status };
  } catch (error) {
    writes.finish(owner, id, 'outcome_unknown');
    throw error;
  }
}

export async function checkApplicationWrite(
  writes: AppWriteRepository,
  owner: string,
  id: string,
  revision: string,
  lookup: ActionBackend,
  signal: AbortSignal,
) {
  const recorded = writes.reconciliation(owner, id);
  if (recorded) return recorded;
  const permitted = () => writes.canCheck(owner, id, revision, lookup.id);
  if (!permitted()) return undefined;
  try {
    const result = await lookup.invoke({
      connectionId: lookup.connectionId, capability: lookup.capability, invocationId: id,
      effect: 'read', input: { blazarInvocationId: id },
    }, signal, async () => permitted());
    if (result.status !== 'succeeded' || !permitted()) return undefined;
    const { structuredContent } = result.output as { structuredContent?: Record<string, unknown> };
    const resolution = structuredContent?.resolution;
    const evidence = structuredContent?.evidence;
    if (structuredContent?.blazarInvocationId !== id || (resolution !== 'applied' && resolution !== 'not_applied') ||
        typeof evidence !== 'string' || !evidence.trim() || evidence.length > 1_024) return undefined;
    writes.reconcile(owner, id, resolution, evidence.trim());
    return writes.reconciliation(owner, id);
  } catch {
    return undefined;
  }
}
