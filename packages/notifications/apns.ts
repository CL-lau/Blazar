import { createPrivateKey, sign } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';

type ApnsConfig = {
  teamId: string;
  keyId: string;
  privateKey: string;
  topic: string;
  sandbox: boolean;
};
export type PushKind = 'approval' | 'task_update';
export type PushResult = 'accepted' | 'unregistered' | 'retry' | 'rejected';

export class ApnsProvider {
  private session?: ClientHttp2Session;
  private jwt?: { value: string; created: number };
  private key;
  private origin: string;
  private closed = false;

  private config: ApnsConfig;
  private transport: typeof connect;
  private clock: () => number;

  constructor(config: ApnsConfig, transport = connect, clock = Date.now) {
    this.config = config;
    this.transport = transport;
    this.clock = clock;
    if (!/^[A-Z0-9]{10}$/.test(config.teamId) || !/^[A-Z0-9]{10}$/.test(config.keyId) ||
        !/^[A-Za-z0-9.-]{1,255}$/.test(config.topic)) throw new Error('Invalid APNs provider configuration');
    this.key = createPrivateKey(config.privateKey);
    if (this.key.asymmetricKeyType !== 'ec' || this.key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('APNs requires a P-256 private key');
    }
    this.origin = config.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  }

  private authorization() {
    const now = Math.floor(this.clock() / 1000);
    if (!this.jwt || now < this.jwt.created || now - this.jwt.created >= 45 * 60) {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: this.config.keyId })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ iss: this.config.teamId, iat: now })).toString('base64url');
      const input = header + '.' + claims;
      const signature = sign('sha256', Buffer.from(input), { key: this.key, dsaEncoding: 'ieee-p1363' });
      this.jwt = { value: 'bearer ' + input + '.' + signature.toString('base64url'), created: now };
    }
    return this.jwt.value;
  }

  private connection() {
    if (this.closed) throw new Error('APNs provider is closed');
    if (this.session && !this.session.destroyed && !this.session.closed) return this.session;
    const session = this.transport(this.origin);
    this.session = session;
    session.on('error', () => session.destroy());
    session.on('goaway', () => session.close());
    session.once('close', () => { if (this.session === session) this.session = undefined; });
    return session;
  }

  async send(deviceToken: string, notificationId: string, kind: PushKind): Promise<PushResult> {
    if (!/^[a-f0-9]{2,512}$/.test(deviceToken) || deviceToken.length % 2 ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(notificationId)) {
      throw new Error('Invalid APNs destination or notification ID');
    }
    const body = JSON.stringify({ aps: { alert: {
      title: 'Blazar',
      body: kind === 'approval' ? 'A task needs your review.' : 'A task has an update.',
    } } });
    try {
      return await new Promise<PushResult>((resolve, reject) => {
        const request = this.connection().request({
          ':method': 'POST', ':path': '/3/device/' + deviceToken,
          authorization: this.authorization(), 'apns-topic': this.config.topic,
          'apns-push-type': 'alert', 'apns-id': notificationId,
          'apns-expiration': String(Math.floor(this.clock() / 1000) + 300),
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        });
        const timer = setTimeout(() => {
          request.close();
          reject(new Error('APNs request timed out'));
        }, 10_000);
        let status = 0;
        let response = '';
        request.setEncoding('utf8');
        request.on('response', headers => { status = Number(headers[':status']); });
        request.on('data', chunk => {
          response += chunk;
          if (response.length > 4_096) {
            request.close();
            reject(new Error('APNs response exceeded the limit'));
          }
        });
        request.once('error', reject);
        request.once('close', () => {
          clearTimeout(timer);
          reject(new Error('APNs response closed'));
        });
        request.once('end', () => {
          if (status === 200) return resolve('accepted');
          if (status === 410) return resolve('unregistered');
          let reason: string | undefined;
          try { reason = JSON.parse(response)?.reason; } catch { /* APNs may return an empty body. */ }
          if (status === 403 && reason === 'ExpiredProviderToken') {
            this.jwt = undefined;
            return resolve('retry');
          }
          resolve(status === 0 || status === 429 || status >= 500 ? 'retry' : 'rejected');
        });
        request.end(body);
      });
    } catch {
      return 'retry';
    }
  }

  close() {
    this.closed = true;
    this.session?.destroy();
  }
}
