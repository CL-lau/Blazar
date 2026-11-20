import assert from 'node:assert/strict';
import test from 'node:test';
import { runJsonWorker, type JsonWorker } from '../../packages/workers/jsonl.ts';

const job = { goal: 'Summarize the notes', instructions: ['Use bullets'], predecessors: [] };

function fixture(protocol: JsonWorker['protocol'], records: string): JsonWorker {
  return {
    label: protocol, protocol, executable: process.execPath,
    args: ['-e', `let text = '';
      process.stdin.on('data', chunk => text += chunk);
      process.stdin.on('end', () => {
        const input = JSON.parse(text);
        const result = input.goal + ': ' + input.instructions[0];
        const emit = record => console.log(JSON.stringify(record));
        ${records}
      });`],
  };
}

test('Claude Code stream-json requires a successful result', async () => {
  const success = fixture('claude', "emit({type:'result',subtype:'success',is_error:false,result});");
  assert.equal(await runJsonWorker(success, process.cwd(), job, AbortSignal.timeout(2_000)), 'Summarize the notes: Use bullets');
  const failure = fixture('claude', "emit({type:'result',subtype:'error',is_error:true,result});");
  await assert.rejects(runJsonWorker(failure, process.cwd(), job, AbortSignal.timeout(2_000)), /completed response/);
});

test('Pi requires a final assistant message and settled run', async () => {
  const prefix = "emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:result}]}});";
  const success = fixture('pi', prefix + "emit({type:'agent_settled',aborted:false});");
  assert.equal(await runJsonWorker(success, process.cwd(), job, AbortSignal.timeout(2_000)), 'Summarize the notes: Use bullets');
  await assert.rejects(runJsonWorker(fixture('pi', prefix), process.cwd(), job, AbortSignal.timeout(2_000)), /completed response/);
});
