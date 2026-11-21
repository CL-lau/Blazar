export const maxTextArtifactBytes = 32_000;

export type TextArtifact = { name: string; text: string };

export function artifactName(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 ||
      value.trim() === '.' || value.trim() === '..' || /[\/\\\x00-\x1f\x7f]/.test(value)) return undefined;
  return value.trim().toWellFormed();
}

export function textArtifact(value: unknown): TextArtifact | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const name = artifactName(input.name);
  if (!name || input.mime !== undefined || typeof input.text !== 'string' ||
      Buffer.byteLength(input.text) > maxTextArtifactBytes) return undefined;
  return { name, text: input.text.toWellFormed() };
}
