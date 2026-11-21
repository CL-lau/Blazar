import type { MemoryDraft } from '../harness.ts';
import type { MemoryStore } from '../memory.ts';
import { RequestError } from '../protocol/request.ts';

export async function requestMemoryDraft(
  store: Pick<MemoryStore, 'resolveAppEvidence' | 'connection'>,
  generate: MemoryDraft,
  owner: string,
  workspace: string,
  reference: { id: string; version: number },
) {
  const resolve = () => store.resolveAppEvidence(owner, workspace, [reference])?.[0];
  const evidence = resolve();
  if (!evidence) throw new RequestError(409, 'Source memory changed or is no longer available');
  const scopeVersion = () => store.connection(owner, evidence.connection, workspace)?.scopeVersion;
  const initialScope = scopeVersion();
  let body: string | null;
  try {
    body = await generate(evidence.body, AbortSignal.timeout(15_000));
  } catch {
    throw new RequestError(503, 'Blazar could not draft a memory. Please retry.');
  }
  if (scopeVersion() !== initialScope || resolve()?.body !== evidence.body) {
    throw new RequestError(409, 'Source memory changed while drafting');
  }
  return { body };
}
