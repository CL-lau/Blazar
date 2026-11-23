import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export function localModelProvider(modelId: string, endpoint = 'http://127.0.0.1:11434/v1') {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('BLAZAR_LOCAL_MODEL_URL must be a loopback HTTP(S) API base URL');
  }

  const baseUrl = url.href.replace(/\/$/, '');
  return createProvider<'openai-completions'>({
    id: 'local',
    name: 'Local inference',
    baseUrl,
    auth: {
      apiKey: {
        name: 'Local inference',
        async resolve() { return { auth: { apiKey: process.env.BLAZAR_LOCAL_MODEL_KEY || 'local' } }; },
      },
    },
    models: [{
      id: modelId, name: modelId, provider: 'local', api: 'openai-completions', baseUrl,
      input: ['text'], reasoning: false, contextWindow: 32_768, maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    }],
    api: openAICompletionsApi(),
  });
}
