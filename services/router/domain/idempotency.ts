export class IdempotencyConflict extends Error {
  constructor() { super('Idempotency key already used'); }
}
