import { readFileSync } from 'node:fs';
import { ApnsProvider } from '../../packages/notifications/apns.ts';
import type { TaskStore } from './store.ts';

export function configuredPush(env: NodeJS.ProcessEnv) {
  const { BLAZAR_APNS_TEAM_ID: teamId, BLAZAR_APNS_KEY_ID: keyId,
    BLAZAR_APNS_KEY_PATH: keyPath, BLAZAR_APNS_TOPIC: topic,
    BLAZAR_APNS_ENVIRONMENT: environment } = env;
  if (!teamId && !keyId && !keyPath && !topic && !environment) return undefined;
  if (!teamId || !keyId || !keyPath || !topic || (environment !== 'sandbox' && environment !== 'production')) {
    throw new Error('Incomplete APNs configuration');
  }
  return new ApnsProvider({
    teamId, keyId, privateKey: readFileSync(keyPath, 'utf8'), topic, sandbox: environment === 'sandbox',
  });
}

export function startPushDelivery(store: TaskStore, provider: ApnsProvider) {
  let delivery: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (delivery) return;
    const item = store.leasePush(Date.now());
    if (!item) return;
    delivery = provider.send(item.token, item.id, item.kind)
      .then(result => store.finishPush(item.id, result, Date.now()))
      .catch(() => console.error('Blazar push delivery could not be recorded'))
      .finally(() => { delivery = undefined; });
  }, 1000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    provider.close();
    await delivery;
  };
}
