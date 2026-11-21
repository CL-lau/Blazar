export const maxTextArtifactBytes = 32_000;

export type TextArtifact = { name: string; text: string };

export function textArtifact(value: unknown): TextArtifact | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { name, text, mime } = value as Record<string, unknown>;
  if (mime !== undefined || typeof name !== 'string' || !name.trim() || name.length > 128 ||
      name.trim() === '.' || name.trim() === '..' || /[\\/\\\\\x00-\x1f\x7f]/.test(name) ||
      typeof text !== 'string' || Buffer.byteLength(text) > maxTextArtifactBytes) return undefined;
  return { name: name.trim().toWellFormed(), text: text.toWellFormed() };
}
