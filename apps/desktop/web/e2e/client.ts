import WebSocket from 'ws';
import type { MethodName, Params, Result } from '@svall/protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class NodeClient {
  private next = 1;
  private pending = new Map<number, Pending>();

  private constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if ('event' in msg) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('error' in msg) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    });
  }

  static connect(port: number, token: string): Promise<NodeClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once('error', reject);
      ws.once('open', () => {
        ws.send(JSON.stringify({ token }));
        ws.once('message', () => resolve(new NodeClient(ws)));
      });
    });
  }

  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void { this.ws.close(); }
}
