import assert from 'node:assert/strict';
import test from 'node:test';
import { runPi } from '../../packages/workers/pi.ts';
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
