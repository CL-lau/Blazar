import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

test('artifact comparisons expose changes only within an authenticated task', async t => {
  const store = new TaskStore(':memory:');
  const task = store.create('owner', 'desktop', 'task', 'project', 'Compare notes');
  const archive = (text: string) => {
    const { run, task } = store.claim('owner', 'project', 'device', 1, 100)!;
    assert.equal(store.finish(run.id, 'device', 2, { status: 'succeeded', result: 'Saved',
      artifact: { name: 'notes.md', text } }), true);
    return store.snapshot('owner').artifacts.find(item => item.taskId === task.id)!.id;
  };
  const first = archive('Header\nOld wording\nFooter');
  store.command('owner', task.id, 1, { action: 'append', text: 'Use revised wording' });
  const second = archive('Header\nNew wording\nFooter');
  store.create('owner', 'desktop', 'other', 'project', 'Unrelated notes');
  const unrelated = archive('Private unrelated content');
  const server = routerServer(store, { owner: 'owner', token: 'fixture' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port + '/v1/artifacts/' + second + '/diff?base=';
  const headers = { Authorization: 'Bearer fixture' };
  assert.equal((await fetch(url + first)).status, 401);
  assert.equal((await fetch(url + unrelated, { headers })).status, 404);
  assert.equal((await fetch(url + 'bad', { headers })).status, 400);
  const response = await fetch(url + first, { headers });
  assert.equal(response.status, 200);
  const { text } = await response.json();
  assert.match(text, / Header\n-Old wording\n\+New wording\n Footer/);
});
