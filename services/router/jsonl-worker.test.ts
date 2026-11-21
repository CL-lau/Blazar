import assert from 'node:assert/strict';
import test from 'node:test';
import { runPi } from '../../packages/workers/pi.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude } from '../../packages/workers/claude.ts';

const job = { goal: 'Summarize the notes', instructions: ['Use bullets'], predecessors: [] };

test('Claude Agent SDK accepts only a successful result from its subprocess', async t => {
  const root = mkdtempSync(join(tmpdir(), 'blazar-claude-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'claude-fixture');
  writeFileSync(script, `#!${process.execPath}
    const assert = require('node:assert/strict');
    const args = process.argv.slice(2);
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--no-session-persistence'));
    const emit = record => console.log(JSON.stringify(record));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const packet = JSON.parse(line);
      if (packet.type === 'control_request') {
        emit({type:'control_response',response:{subtype:'success',request_id:packet.request_id,response:{}}});
      } else if (packet.type === 'user') {
        const content = packet.message.content;
        const input = JSON.parse(typeof content === 'string' ? content : content[0].text);
        const failed = input.goal === 'Fail';
        emit({type:'result',subtype:failed?'error_during_execution':'success',is_error:failed,
          result:input.goal + ': ' + input.instructions[0]});
      }
    });
  `, { mode: 0o700 });
  const worker = { label: 'Claude', protocol: 'claude' as const, executable: script, args: [] };
  assert.equal(await runClaude(worker, root, job, AbortSignal.timeout(3_000)), 'Summarize the notes: Use bullets');
  await assert.rejects(runClaude(worker, root, { ...job, goal: 'Fail' }, AbortSignal.timeout(3_000)), /completed response/);
});

test('Pi RPC requires a correlated prompt acknowledgment and a settled run', async () => {
  const worker = (settle: boolean) => ({
    label: 'Pi', protocol: 'pi' as const, executable: process.execPath,
    args: ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const { id, type, message } = JSON.parse(line);
        if (type !== 'prompt') return;
        const emit = value => console.log(JSON.stringify(value));
        const input = JSON.parse(message);
        const text = input.goal + ': ' + input.instructions[0] + String.fromCodePoint(0x2028) + 'done';
        emit({id,type:'response',command:'prompt',success:true,data:{disposition:'started'}});
        emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
        if (${settle}) emit({type:'agent_settled',aborted:false});
        else process.exit(0);
      });
    `],
  });
  assert.equal(await runPi(worker(true), process.cwd(), job, AbortSignal.timeout(2_000)),
    'Summarize the notes: Use bullets' + String.fromCodePoint(0x2028) + 'done');
  await assert.rejects(runPi(worker(false), process.cwd(), job, AbortSignal.timeout(2_000)), /exited before/);
});

test('Pi only acknowledges steering after the queued message enters the run', async () => {
  const worker = {
    label: 'Pi steering fixture', executable: process.execPath,
    args: ['-e', `
      const emit = record => console.log(JSON.stringify(record));
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const { id, type, message } = JSON.parse(line);
        if (type === 'prompt') {
          emit({id,type:'response',command:'prompt',success:true,data:{disposition:'started'}});
        }
        if (type === 'steer') {
          emit({type:'message_end',message:{role:'user',content:message}});
          emit({id,type:'response',command:'steer',success:true,data:{disposition:'queued'}});
          emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:message}]}});
          emit({type:'agent_settled',aborted:false});
        }
      });
    `],
  };
  const accepted = Promise.withResolvers<boolean>();
  const result = await runPi(worker, process.cwd(), job, AbortSignal.timeout(3_000), steer => {
    accepted.resolve(steer('Use the latest instructions', 'revision-2'));
    return () => {};
  });
  assert.equal(await accepted.promise, true);
  assert.equal(result, 'Use the latest instructions');
});
