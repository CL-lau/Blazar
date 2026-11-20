import assert from 'node:assert/strict';
import test from 'node:test';
import { runAider } from '../../packages/workers/aider.ts';

const worker = {
  executable: process.execPath, label: 'Aider fixture',
  args: ['-e', String.raw`
    const { readFileSync, writeFileSync } = require('node:fs');
    const flag = name => process.argv[process.argv.indexOf(name) + 1];
    const request = JSON.parse(readFileSync(flag('--message-file'), 'utf8'));
    const response = request.goal === 'empty' ? '' : 'ASSISTANT Checklist\nASSISTANT - Review notes\n';
    writeFileSync(flag('--llm-history-file'), 'TO LLM 2025-01-01T00:00:00\nUSER private prompt\nLLM RESPONSE 2025-01-01T00:00:01\n' + response);
  `, '--'],
};

test('Aider exposes the assistant reply and excludes the private request transcript', async () => {
  const job = { goal: 'Prepare the checklist', instructions: [], predecessors: [] };
  assert.equal(await runAider(worker, process.cwd(), job, AbortSignal.timeout(2_000)), 'Checklist\n- Review notes');
  await assert.rejects(runAider(worker, process.cwd(), { ...job, goal: 'empty' }, AbortSignal.timeout(2_000)), /no usable reply/);
});
