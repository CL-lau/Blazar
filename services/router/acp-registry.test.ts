import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorker } from '../../packages/workers/registry.ts';
import test from 'node:test';
import { readAcpRegistry, registryWorkerManifest } from '../../packages/workers/acp-registry.ts';

test('ACP registry import pins package launch arguments and validates the selected distribution', async t => {
  const transport: typeof fetch = async (url, options) => {
    assert.equal(String(url), 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json');
    assert.equal(options?.redirect, 'error');
    return Response.json({
      version: '1.0.0',
      agents: [
        { id: 'fixture', name: 'Fixture Agent', version: '1.2.3',
          distribution: { npx: { package: '@sample/worker@1.2.3', args: ['--acp'], env: { SAMPLE_KEY: 'configured externally' } } } },
        { id: 'invalid id', name: 'Invalid', version: '1.2.3', distribution: {} },
      ],
    });
  };
  const entries = await readAcpRegistry(transport);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  const manifest = await registryWorkerManifest(entry, 'npx');
  assert.equal(manifest.protocol, 'acp');
  assert.equal(manifest.startupTimeoutSeconds, 60);
  assert.equal(manifest.label, 'Fixture Agent 1.2.3');
  assert.deepEqual(manifest.args, ['--yes', '@sample/worker@1.2.3', '--acp']);
  assert.deepEqual(manifest.env, ['SAMPLE_KEY']);
  assert.doesNotMatch(JSON.stringify(manifest), /configured externally/);
  const directory = await mkdtemp(join(tmpdir(), 'blazar-registry-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'worker.json');
  await writeFile(path, JSON.stringify(manifest));
  const imported = await resolveWorker('custom', path);
  assert.equal(imported?.protocol, 'acp');
  assert(imported?.protocol === 'acp');
  assert.equal(imported.startupTimeoutSeconds, 60);
  await writeFile(path, JSON.stringify({ ...manifest, startupTimeoutSeconds: 61 }));
  await assert.rejects(resolveWorker('custom', path), /Invalid ACP Worker startup timeout/);
  await assert.rejects(registryWorkerManifest(entry, 'binary'), /unavailable/);
  await assert.rejects(registryWorkerManifest({ ...entry, distribution: {
    npx: { package: '@sample/worker@latest' },
  } }, 'npx'), /must use an exact version/);
});
