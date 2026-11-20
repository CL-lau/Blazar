import WebSocket from 'ws';

type Pending = { socket: WebSocket; resolve: (response: Response) => void; reject: (error: Error) => void };

export class DeviceSocket {
  private endpoint: URL;
  private token: string;
  private socket?: WebSocket;
  private opening?: Promise<WebSocket>;
  private pending = new Map<number, Pending>();
  private id = 0;
  private stopListeners = new Map<string, () => void>();

  constructor(base: URL, token: string) {
    this.endpoint = new URL('/v1/devices/connect', base);
    this.endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    this.token = token;
  }

  private connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    const socket = new WebSocket(this.endpoint, {
      headers: { Authorization: `Bearer ${this.token}`, 'X-Blazar-Device-Stop-Push': '1' }, handshakeTimeout: 4_000,
      followRedirects: false, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false,
    });
    this.socket = socket;
    const ready = Promise.withResolvers<WebSocket>();
    this.opening = ready.promise;
    socket.once('open', () => {
      this.opening = undefined;
      ready.resolve(socket);
    });
    socket.on('error', () => socket.terminate());
    socket.once('close', () => {
      ready.reject(new Error('Device connection closed'));
      if (this.socket === socket) {
        this.socket = undefined;
        this.opening = undefined;
      }
      for (const [id, pending] of this.pending) {
        if (pending.socket !== socket) continue;
        pending.reject(new Error('Device connection closed'));
        this.pending.delete(id);
      }
    });
    socket.on('message', data => {
      if (this.socket !== socket) return;
      try {
        const reply = JSON.parse(data.toString());
        if (reply.type === 'run.stop' && typeof reply.runId === 'string' && /^[a-f0-9-]{36}$/.test(reply.runId)) {
          this.stopListeners.get(reply.runId)?.();
          return;
        }
        if (!Number.isSafeInteger(reply.id) || !Number.isInteger(reply.status) ||
            reply.status < 200 || reply.status > 599 || !reply.body) {
          socket.terminate();
          return;
        }
        this.pending.get(reply.id)?.resolve(Response.json(reply.body, { status: reply.status }));
      } catch {
        socket.terminate();
      }
    });
    return ready.promise;
  }

  async request(path: string, body: object, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(5_000);
    const active = AbortSignal.any([signal, timeout]);
    active.throwIfAborted();
    const deferred = Promise.withResolvers<Response>();
    const id = ++this.id;
    const abort = () => {
      const pending = this.pending.get(id);
      if (timeout.aborted) pending?.socket.terminate();
      deferred.reject(new Error('Device request cancelled or timed out'));
    };
    active.addEventListener('abort', abort, { once: true });
    const socketRequest = this.connect().then(socket => {
      active.throwIfAborted();
      this.pending.set(id, { ...deferred, socket });
      socket.send(JSON.stringify({ id, path, body }), error => {
        if (error) deferred.reject(new Error('Device request could not be sent'));
      });
      return deferred.promise;
    });
    try {
      return await Promise.race([socketRequest, deferred.promise]);
    } finally {
      active.removeEventListener('abort', abort);
      this.pending.delete(id);
    }
  }

  onStop(runId: string, handler: () => void) {
    this.stopListeners.set(runId, handler);
    return () => this.stopListeners.delete(runId);
  }

  close() {
    this.socket?.terminate();
  }
}
