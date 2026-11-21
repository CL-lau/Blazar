import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeApplicationAction, type ActionBackend, type ApplicationAction } from '../../packages/apps/actions.ts';

const action: ApplicationAction = {
  connectionId: 'account-one', capability: 'document.update', invocationId: 'operation-1', effect: 'write', input: {},
};

test('application actions authorize matching fallback backends separately', async () => {
  const visited: string[] = [];
  const primary: ActionBackend = {
    ...action, id: 'api', async invoke() { return { status: 'unavailable-before-dispatch' }; },
  };
  const fallback: ActionBackend = {
    ...action, id: 'browser', async invoke() { return { status: 'succeeded', output: 'updated' }; },
  };
  const otherAccount = { ...fallback, id: 'other-account', connectionId: 'account-two' };
  const outcome = await invokeApplicationAction(action, [primary, otherAccount, fallback], async backend => {
    visited.push(backend.id);
    return backend.id !== 'browser';
  }, new AbortController().signal);
  assert.deepEqual(visited, ['api', 'browser']);
  assert.deepEqual(outcome, { status: 'denied' });
  assert.deepEqual(await invokeApplicationAction(action, [primary, fallback], async () => true,
    new AbortController().signal), { status: 'succeeded', output: 'updated' });
});

test('application writes stop at the backend with an ambiguous outcome', async () => {
  const primary: ActionBackend = {
    ...action, id: 'api', async invoke() { throw new Error('Connection lost after dispatch'); },
  };
  const outcome = await invokeApplicationAction(action, [primary, { ...primary, id: 'browser' }], async backend => {
    assert.equal(backend.id, 'api');
    return true;
  }, new AbortController().signal);
  assert.deepEqual(outcome, { status: 'outcome-unknown', backendId: 'api' });
});
