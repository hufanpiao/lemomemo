// 本机推送替身的端口一侧（push-service.ts 的 listen 用）：只听 127.0.0.1，把 node:http 的请求转成替身的 Incoming。
// handler 回 Response 就照写回去（响应体按流一块一块写，发送方断开就停）；回 null 表示“不回”（挂住被放弃、拖延中发送方断开、替身关闭），
// 回 'reset' 表示网络错误，都直接断开连接；handler 抛错时回 500（代码审查 M4：不能变成未处理异常、把连接挂住）。
// node:http 在 Node 和 Deno 里都能用
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type Incoming = { method: string; url: string; headers: Headers; body: Uint8Array<ArrayBuffer>; viaRedirect: boolean };
export type Outgoing = Response | null | 'reset';
export type PortHandler = (inc: Incoming, signal: AbortSignal) => Promise<Outgoing>;

export class LoopbackServer {
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;
  readonly origin: string;

  private constructor(server: Server, origin: string) {
    this.server = server;
    this.origin = origin;
  }

  /** port 为 0 时随机分配；端口被占时抛错 */
  static async start(port: number, handler: PortHandler): Promise<LoopbackServer> {
    let self: LoopbackServer | null = null;
    const server = createServer((req, res) => {
      if (self) void onNode(self.origin, handler, req, res);
    });
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', fail);
        ok();
      });
    });
    self = new LoopbackServer(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const sockets = self.sockets;
    server.on('connection', (s: Socket) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    return self;
  }

  /** 断开所有连接（含挂着的），释放端口 */
  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((ok) => this.server.close(() => ok()));
  }
}

async function writeBody(res: ServerResponse, body: ReadableStream<Uint8Array>, gone: AbortSignal): Promise<void> {
  const reader = body.getReader();
  gone.addEventListener('abort', () => void reader.cancel().catch(() => undefined), { once: true });
  for (;;) {
    const { done, value } = await reader.read();
    if (done || gone.aborted) break;
    if (!res.write(value)) await new Promise<void>((ok) => res.once('drain', ok).once('close', ok));
  }
  if (!gone.aborted) res.end();
}

async function onNode(origin: string, handler: PortHandler, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const client = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) client.abort();
  });
  try {
    const chunks: Buffer[] = [];
    try {
      for await (const c of req) chunks.push(c as Buffer);
    } catch {
      return; // 发送方传一半断了
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const body = new Uint8Array(Buffer.concat(chunks));
    const out = await handler({ method: req.method ?? 'GET', url: `${origin}${req.url ?? '/'}`, headers, body, viaRedirect: false }, client.signal);
    if (out === null || out === 'reset') {
      if (!res.destroyed) res.destroy();
      return;
    }
    const h: Record<string, string> = { connection: 'close' };
    out.headers.forEach((v, k) => {
      h[k] = v;
    });
    res.writeHead(out.status, h);
    if (out.body) await writeBody(res, out.body, client.signal);
    else res.end();
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain', connection: 'close' });
      res.end(`fake push service error: ${e instanceof Error ? e.message : String(e)}`);
    } else if (!res.destroyed) {
      res.destroy();
    }
  }
}

/** 等 ms 毫秒；signal 先断就提前回 false */
export function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((ok) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      ok(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      ok(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
