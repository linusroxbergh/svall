import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkFrame } from '@svall/protocol';
import { LinkStream } from '../../src/link/stream.js';

function pair() {
  const a = new PassThrough();
  const b = new PassThrough();
  return [Duplex.from({ readable: a, writable: b }), Duplex.from({ readable: b, writable: a })] as const;
}

function ends(maxLine?: number) {
  const [da, db] = pair();
  const got: LinkFrame[] = [];
  const closed: (Error | undefined)[] = [];
  const mk = (d: Duplex, onFrame: (f: LinkFrame) => void) => new LinkStream(d, { onFrame, onClose: (e) => closed.push(e), maxLine });
  const a = mk(da, () => {});
  const b = mk(db, (f) => got.push(f));
  return { a, b, got, closed, da, db };
}

const tmp: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('LinkStream', () => {
  it('answers a call with the reply that names its id, in any order', async () => {
    const { a, b, got } = ends();
    const one = a.call<string>('one', {});
    const two = a.call<string>('two', {});
    await vi.waitFor(() => expect(got).toHaveLength(2));
    const ids = got.map((f) => (f.t === 'call' ? f.id : -1));
    b.send({ t: 'reply', id: ids[1]!, result: 'second' });
    b.send({ t: 'reply', id: ids[0]!, result: 'first' });
    expect(await Promise.all([one, two])).toEqual(['first', 'second']);
  });

  it('rejects every pending call with not_reachable when the stream closes', async () => {
    const { a, b } = ends();
    const one = a.call('one', {});
    const two = a.call('two', {});
    b.close();
    await expect(one).rejects.toMatchObject({ code: 'not_reachable' });
    await expect(two).rejects.toMatchObject({ code: 'not_reachable' });
  });

  it('rejects a call with timeout when no reply comes', async () => {
    vi.useFakeTimers();
    const { a } = ends();
    const call = a.call('slow', {}, { timeoutMs: 1000 });
    const check = expect(call).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1000);
    await check;
  });

  it('carries a 3 MiB blob in 1 MiB parts and verifies its sha256 on arrival', async () => {
    const { a, b } = ends();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-blob-'));
    tmp.push(dir);
    const into = path.join(dir, 'out.bin');
    const data = crypto.randomBytes(3 * 1024 * 1024);
    const received = b.receiveBlob('b1', into);
    await a.sendBlob('b1', data, data.length);
    const { sha256 } = await received;
    expect(sha256).toBe(crypto.createHash('sha256').update(data).digest('hex'));
    expect(fs.readFileSync(into).equals(data)).toBe(true);
  });

  it('closes on a line over MAX_LINE and says the size', async () => {
    const { a, b, closed } = ends(1024);
    void b;
    a.send({ t: 'event', seq: 1, kind: 'big', data: 'x'.repeat(4096) });
    await vi.waitFor(() => expect(closed.length).toBeGreaterThan(0));
    expect(closed.find((e) => e)?.message).toMatch(/1024/);
  });

  it('fails sendBlob with not_reachable on a closed link', async () => {
    const { a } = ends();
    a.close();
    await expect(a.sendBlob('b1', Buffer.alloc(10), 10)).rejects.toMatchObject({ code: 'not_reachable' });
  });

  it('fails a blob whose target cannot be written, closing the link instead of crashing', async () => {
    const { a, b, closed } = ends();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-blob-'));
    tmp.push(dir);
    const received = b.receiveBlob('b1', path.join(dir, 'missing', 'out.bin'));
    const failed = expect(received).rejects.toMatchObject({ code: 'not_reachable' });
    void a.sendBlob('b1', Buffer.alloc(10), 10).catch(() => {});
    await failed;
    await vi.waitFor(() => expect(closed.length).toBeGreaterThan(0));
  });
});
