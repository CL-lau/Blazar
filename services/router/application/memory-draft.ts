import type { MemoryDraft } from '../harness.ts';
import type { MemoryStore } from '../memory.ts';
import { RequestError } from '../protocol/request.ts';

export async function requestMemoryDraft(
  store: Pick<MemoryStore, 'resolveAppEvidence' | 'connection'>,
  generate: MemoryDraft,
  owner: string,
  workspace: string,
  reference: { id: string; version: number },
  signal?: AbortSignal,
  reserve?: (signal?: AbortSignal) => Promise<() => void>,
) {
  const resolve = () => store.resolveAppEvidence(owner, workspace, [reference])?.[0];
  const evidence = resolve();
  if (!evidence) throw new RequestError(409, 'Source memory changed or is no longer available');
  const scopeVersion = () => store.connection(owner, evidence.connection, workspace)?.scopeVersion;
  const initialScope = scopeVersion();
  const checkSource = () => {
    signal?.throwIfAborted();
    if (scopeVersion() !== initialScope || resolve()?.body !== evidence.body) {
      throw new RequestError(409, 'Source memory changed while drafting');
    }
  };
  const release = await reserve?.(signal);
  let body: string | null;
  try {
    checkSource();
    const timeout = AbortSignal.timeout(15_000);
    body = await generate(evidence.body, signal ? AbortSignal.any([timeout, signal]) : timeout);
  } catch {
    checkSource();
    throw new RequestError(503, 'Blazar could not draft a memory. Please retry.');
  } finally {
    release?.();
  }
  checkSource();
  return { body };
}
