import type { TaskAttachment } from '../../../packages/protocol/task.ts';
import { RequestError, requiredText } from '../protocol/request.ts';

export function textAttachments(value: unknown): TaskAttachment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new RequestError(400, 'Invalid task attachments');
  let bytes = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RequestError(400, 'Invalid task attachment');
    const name = requiredText(item.name, 'attachment name', 128);
    const text = requiredText(item.text, 'attachment text', 8_192).toWellFormed();
    bytes += Buffer.byteLength(text);
    if (/[\x00-\x1f\x7f/\\]/.test(name) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || bytes > 16_384) {
      throw new RequestError(400, 'Invalid task attachment text or size');
    }
    return { name: name.toWellFormed(), text };
  });
}
