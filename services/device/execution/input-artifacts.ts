import { createHash } from 'node:crypto';
import type { PredecessorInput } from '../../../packages/protocol/task.ts';

export type ArtifactPost = (path: string, data: object, signal: AbortSignal) => Promise<Response>;

function verifyArtifact(text: unknown, artifact: { size: number; sha256: string }): asserts text is string {
  if (typeof text !== 'string' || Buffer.byteLength(text) !== artifact.size ||
      createHash('sha256').update(text).digest('hex') !== artifact.sha256) {
    throw new Error('Workflow input artifact failed integrity verification');
  }
}

export async function completeInputArtifacts(post: ArtifactPost, inputs: PredecessorInput[], prefix: string, signal: AbortSignal, required: boolean) {
  let budget = 64_000;
  if (required && inputs.reduce((total, input) => total + (input.artifact?.size ?? 0), 0) > budget) {
    throw new Error('Required workflow input artifacts exceed the device input budget');
  }
  for (const input of inputs) {
    const artifact = input.artifact;
    if (!artifact || artifact.size <= 0) continue;
    if (!artifact.truncated) {
      if (required) {
        verifyArtifact(artifact.excerpt, artifact);
        artifact.text = artifact.excerpt;
      }
      continue;
    }
    if (artifact.size > budget) continue;
    const response = await post(prefix + 'input-artifact', { artifactId: artifact.id }, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Unable to read a required workflow input');
    }
    const { text } = await response.json() as { text?: unknown };
    verifyArtifact(text, artifact);
    artifact.text = text;
    budget -= artifact.size;
  }
}
