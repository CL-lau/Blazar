export type ApplicationAction = Readonly<{
  connectionId: string;
  capability: string;
  invocationId: string;
  effect: 'read' | 'write';
  input: Readonly<Record<string, unknown>>;
}>;

export type ActionResult<Output = unknown> =
  | { status: 'succeeded'; output: Output }
  | { status: 'unavailable-before-dispatch' }
  | { status: 'denied' }
  | { status: 'outcome-unknown'; backendId: string };

export interface ActionBackend<Output = unknown> {
  readonly id: string;
  readonly connectionId: string;
  readonly capability: string;
  readonly effect: ApplicationAction['effect'];
  invoke(action: ApplicationAction, signal: AbortSignal, authorizeDispatch: () => Promise<boolean>): Promise<Exclude<ActionResult<Output>, { status: 'outcome-unknown' }>>;
}

// The caller supplies backends in policy order and authorizes each separately.
export async function invokeApplicationAction<Output>(
  action: ApplicationAction,
  backends: readonly ActionBackend<Output>[],
  authorized: (backend: ActionBackend<Output>, action: ApplicationAction) => Promise<boolean>,
  signal: AbortSignal,
): Promise<ActionResult<Output>> {
  signal.throwIfAborted();
  for (const backend of backends) {
    if (backend.connectionId !== action.connectionId || backend.capability !== action.capability ||
        backend.effect !== action.effect) continue;
    if (!await authorized(backend, action)) return { status: 'denied' };
    signal.throwIfAborted();
    let result: Awaited<ReturnType<ActionBackend<Output>['invoke']>>;
    try {
      result = await backend.invoke(action, signal, () => authorized(backend, action));
    } catch (error) {
      if (action.effect === 'write') return { status: 'outcome-unknown', backendId: backend.id };
      throw error;
    }
    if (result.status !== 'unavailable-before-dispatch') return result;
    signal.throwIfAborted();
  }
  return { status: 'unavailable-before-dispatch' };
}
