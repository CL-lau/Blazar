import { readAcpRegistry, registryListing } from '../../../packages/workers/acp-registry.ts';
import { RequestError } from '../protocol/request.ts';

export function createWorkerRegistry() {
  let cached: { items: ReturnType<typeof registryListing>; fetchedAt: number } | undefined;
  let pending: Promise<NonNullable<typeof cached>> | undefined;

  return async () => {
    if (cached && Date.now() - cached.fetchedAt < 5 * 60_000) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        cached = { items: registryListing(await readAcpRegistry()), fetchedAt: Date.now() };
        return cached;
      } catch {
        throw new RequestError(502, 'The ACP Registry is unavailable');
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}
