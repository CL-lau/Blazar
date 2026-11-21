import type { CustomJsonlWorker } from './custom-jsonl.ts';
import type { PiWorker } from './pi.ts';
import type { ClaudeWorker } from './claude.ts';
import type { WorkerCommand } from './process.ts';
import { access, constants, readFile, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { deepSeekWorker, type AcpWorker } from './acp.ts';

export type Worker = (WorkerCommand & { protocol: 'codex' | 'aider' }) | (AcpWorker & { protocol?: 'acp' }) | ClaudeWorker | PiWorker | CustomJsonlWorker;

const builtInWorkers = new Map<string, Worker>([
  ['codex', { executable: 'codex', args: ['app-server'], label: 'Codex', protocol: 'codex', env: ['OPENAI_API_KEY', 'CODEX_HOME'] }],
  ['aider', { executable: 'aider', label: 'Aider', protocol: 'aider',
    args: ['--chat-mode', 'ask', '--no-stream', '--no-pretty', '--no-git', '--dry-run',
      '--no-auto-commits', '--no-auto-lint', '--no-auto-test', '--no-suggest-shell-commands',
      '--no-check-update', '--no-analytics'],
    env: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'AIDER_MODEL', 'AIDER_OPENAI_API_BASE'] }],
  ['claude', { executable: 'claude', label: 'Claude Code', protocol: 'claude',
    args: [],
    env: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'] }],
  ['pi', { executable: 'pi', label: 'Pi', protocol: 'pi',
    args: ['--mode', 'rpc', '--no-tools', '--no-extensions', '--no-mcp', '--no-session',
      '--no-context-files', '--no-prompt-templates', '--no-skills'],
    env: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'PI_CODING_AGENT_DIR'] }],
  ['deepseek', deepSeekWorker],
  ['opencode', { executable: 'opencode', args: ['acp'], label: 'OpenCode',
    env: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY'] }],
  ['copilot', { executable: 'copilot', args: ['--acp', '--stdio'], label: 'GitHub Copilot CLI',
    env: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] }],
  ['droid', { executable: 'droid', args: ['exec', '--output-format', 'acp-daemon'], label: 'Factory Droid',
    env: ['FACTORY_API_KEY'] }],
  ['qwen', { executable: 'qwen', args: ['--acp'], label: 'Qwen Code',
    env: ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY'] }],
  ['kimi', { executable: 'kimi', args: ['acp'], label: 'Kimi Code',
    env: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] }],
  ['kiro', { executable: 'kiro-cli', args: ['acp', '--agent-engine=v3'], label: 'Kiro CLI' }],
  ['auggie', { executable: 'auggie', args: ['--acp'], label: 'Auggie' }],
  ['gemini', { executable: 'gemini', args: ['--acp'], label: 'Gemini CLI',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] }],
  ['cursor', { executable: 'cursor-agent', args: ['acp'], label: 'Cursor Agent',
    env: ['CURSOR_API_KEY'] }],
  ['antigravity', { executable: 'agy_acp_server.par', args: [], label: 'Google Antigravity ACP',
    env: ['GOOGLE_APPLICATION_CREDENTIALS'] }],
  ['cline', { executable: 'cline', args: ['--acp'], label: 'Cline' }],
  ['goose', { executable: 'goose', args: ['acp'], label: 'Goose',
    env: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] }],
  ['amp', { executable: 'amp-acp', args: [], label: 'Amp ACP',
    env: ['AMP_API_KEY'] }],
]);

export function workerCatalog() {
  return Array.from(builtInWorkers, ([id, worker]) => ({
    id, label: worker.label, protocol: worker.protocol ?? 'acp',
  }));
}

export async function resolveWorker(mode: string, manifest?: string, executableOverride?: string): Promise<Worker | undefined> {
  if (mode === 'preview') return undefined;
  if (mode !== 'custom') {
    const worker = builtInWorkers.get(mode);
    if (!worker) throw new Error('Unsupported configured device worker');
    if (executableOverride && !isAbsolute(executableOverride)) throw new Error('Worker executable override must be absolute');
    if (worker.protocol === 'claude' && !executableOverride) return worker;
    return { ...worker, executable: await locate(executableOverride || worker.executable) };
  }
  if (!manifest || !isAbsolute(manifest)) throw new Error('Set an absolute BLAZAR_WORKER_MANIFEST path');
  const metadata = await stat(manifest);
  if (!metadata.isFile() || metadata.size > 16_384) throw new Error('Invalid worker manifest file');
  const data = JSON.parse(await readFile(manifest, 'utf8'));
  if (!data || data.version !== 1 || (data.protocol !== 'acp' && data.protocol !== 'jsonl') ||
      typeof data.label !== 'string' || !data.label.trim() || data.label.length > 128 ||
      typeof data.executable !== 'string' || !isAbsolute(data.executable) ||
      !Array.isArray(data.args) || data.args.length > 32 ||
      data.args.some((value: unknown) => typeof value !== 'string' || value.length > 2_048 || value.includes('\0'))) {
    throw new Error('Invalid worker manifest');
  }
  if (data.includeFullInputArtifacts !== undefined &&
      (data.protocol !== 'jsonl' || typeof data.includeFullInputArtifacts !== 'boolean')) {
    throw new Error('Invalid full-artifact option in Worker manifest');
  }
  const env = data.env ?? [];
  if (!Array.isArray(env) || env.length > 32 || env.some((key: unknown) =>
    typeof key !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(key) || /^(BLAZAR_|NODE_OPTIONS$|DYLD_|LD_)/.test(key))) {
    throw new Error('Invalid worker environment list');
  }
  const worker = { executable: await locate(data.executable), label: data.label, args: data.args, env };
  return data.protocol === 'jsonl' ? { ...worker, protocol: 'jsonl', includeFullInputArtifacts: data.includeFullInputArtifacts }
    : { ...worker, protocol: 'acp' };
}

async function locate(executable: string): Promise<string> {
  const candidates = isAbsolute(executable) ? [executable] : (process.env.PATH ?? '').split(delimiter)
    .filter(isAbsolute).flatMap(directory => process.platform === 'win32'
      ? [join(directory, executable + '.exe'), join(directory, executable)] : [join(directory, executable)]);
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue checking PATH entries.
    }
  }
  throw new Error('Configured worker executable is unavailable: ' + executable);
}
