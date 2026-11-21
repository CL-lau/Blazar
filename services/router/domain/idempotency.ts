export class IdempotencyConflict extends Error {
  constructor() { super('Idempotency key already used'); }
}

export class StaleRoutingEvidence extends Error {
  constructor() { super('Task result changed after routing. Use a new request key.'); }
}
