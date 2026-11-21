import { browserDeviceServer } from './browser-service.ts';

function setting(name: string) {
  const value = process.env['BLAZAR_BROWSER_' + name];
  if (!value?.trim()) throw new Error('Set BLAZAR_BROWSER_' + name);
  return value;
}

const port = Number(process.env.BLAZAR_BROWSER_PORT ?? 4201);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid BLAZAR_BROWSER_PORT');
const tool = setting('TOOL');
const server = browserDeviceServer({
  token: setting('TOKEN'), tool, receiptPath: setting('RECEIPTS'),
  form: {
    id: 'device-browser', capability: tool, url: setting('URL'), submitUrl: setting('SUBMIT_URL'),
    button: setting('BUTTON'), inputLabel: setting('INPUT_LABEL'), inputKey: setting('INPUT_KEY'),
    storageState: process.env.BLAZAR_BROWSER_STORAGE_STATE,
  },
});
server.listen(port, '127.0.0.1', () => console.log('Blazar browser device listening on loopback port ' + port));
