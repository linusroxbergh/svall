import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkFrame } from '@svall/protocol';
import { answerCall, LinkStream, MAX_LINE, PART_REPLY, PART_SLICE } from '../../src/link/stream.js';

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

// two ends, b answering each call with `run`, and every line either writes
function served(run: (params: unknown) => Promise<unknown>) {
  const [da, db] = pair();
  const linesSeen: string[] = [];
  for (const d of [da, db]) {
    const write = d.write.bind(d) as (line: string) => boolean;
    d.write = ((line: string) => { linesSeen.push(line.slice(0, -1)); return write(line); }) as Duplex['write'];
  }
  const a = new LinkStream(da, { onFrame: () => {}, onClose: () => {} });
  const b: LinkStream = new LinkStream(db, { onFrame: (f) => { if (f.t === 'call') void answerCall(b, f, run); }, onClose: () => {} });
  return { a, linesSeen };
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

  it('replies whole up to 1 MiB of JSON, in parts past it, on lines of at most 2 MiB', async () => {
    expect([PART_REPLY, PART_SLICE, MAX_LINE]).toEqual([1024 * 1024, 768 * 1024, 2 * 1024 * 1024]);
    // {"text":"…"} is 11 bytes around the text
    const whole = served(async () => ({ text: 'x'.repeat(1024 * 1024 - 11) }));
    await whole.a.call('big', {});
    expect(whole.linesSeen.filter((l) => l.includes('"link.part"'))).toEqual([]);
    const parted = served(async () => ({ text: 'x'.repeat(1024 * 1024 - 10) }));
    await parted.a.call('big', {});
    expect(parted.linesSeen.filter((l) => l.includes('"link.part"'))).toHaveLength(2);
  });

  it('a reply over PART_REPLY arrives whole through link.part, in 768 KiB slices', async () => {
    const text = 'x'.repeat(3 * 1024 * 1024 - 64);
    const { a, linesSeen } = served(async () => ({ text }));
    expect(await a.call('big', {})).toEqual({ text });
    expect(linesSeen.filter((l) => l.includes('"link.part"'))).toHaveLength(4);
  });

  it('a 2 MiB reply of JSON text with many escapes travels, every line under MAX_LINE', async () => {
    const text = '"\\'.repeat(512 * 1024);
    const { a, linesSeen } = served(async () => ({ text }));
    expect(await a.call('big', {})).toEqual({ text });
    expect(linesSeen.every((l) => Buffer.byteLength(l) <= MAX_LINE)).toBe(true);
  });

  it('lets a reply in parts go once its last part is asked, or a minute after a part was last served', async () => {
    const { a } = served(async () => ({ text: 'x'.repeat(PART_REPLY) }));
    await a.call('big', {});
    await expect(a.call('link.part', { id: '1', index: 0 })).rejects.toMatchObject({ code: 'not_found' });

    vi.useFakeTimers();
    const s = new LinkStream(pair()[0], { onFrame: () => {}, onClose: () => {} });
    const { __parts } = s.fitReply({ text: 'x'.repeat(PART_REPLY) }) as { __parts: { id: string; count: number } };
    expect(__parts.count).toBe(2);
    vi.advanceTimersByTime(59_999);
    // the base64 of 768 KiB, and a minute more for the rest
    expect(s.replyPart({ id: __parts.id, index: 0 }).data).toHaveLength(1024 * 1024);
    vi.advanceTimersByTime(59_999);
    expect(s.replyPart({ id: __parts.id, index: 0 }).data).toHaveLength(1024 * 1024);
    vi.advanceTimersByTime(60_000);
    expect(() => s.replyPart({ id: __parts.id, index: 1 })).toThrow('part 1 of reply 1 is not held');
  });

  it("a reply in parts keeps its call's one deadline, and one whose parts expired between two says so", async () => {
    vi.useFakeTimers();
    // b answers each link.part `late` ms after it is asked
    const slow = (late: number) => {
      const [da, db] = pair();
      const b: LinkStream = new LinkStream(db, {
        onFrame: (f) => {
          if (f.t !== 'call') return;
          if (f.method === 'link.part') setTimeout(() => void answerCall(b, f), late);
          else void answerCall(b, f, async () => ({ text: 'x'.repeat(3 * 1024 * 1024) }));
        },
        onClose: () => {},
      });
      return new LinkStream(da, { onFrame: () => {}, onClose: () => {} });
    };
    const failure = (p: Promise<unknown>) => {
      const got: { e?: unknown } = {};
      p.catch((e: unknown) => { got.e = e; });
      return got;
    };
    const timed = failure(slow(20_000).call('big', {}, { timeoutMs: 30_000 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(timed.e).toMatchObject({ code: 'timeout', message: 'big got no reply in 30000 ms' });

    const expired = failure(slow(60_001).call('big', {}, { timeoutMs: 120_000 }));
    await vi.advanceTimersByTimeAsync(60_001);
    expect(expired.e).toMatchObject({ code: 'timeout', message: "big's reply expired before it all arrived; try again" });
  });

  it('backlog reports the bytes not yet written to the duplex', async () => {
    const [da, db] = pair();
    const a = new LinkStream(da, { onFrame: () => {}, onClose: () => {} });
    expect(a.backlog()).toBe(0);
    const answered = a.call('echo', 'x'.repeat(100_000));
    expect(a.backlog()).toBeGreaterThan(0);
    // the peer starts reading only now
    const b: LinkStream = new LinkStream(db, { onFrame: (f) => { if (f.t === 'call') void answerCall(b, f, async (p) => p); }, onClose: () => {} });
    expect(await answered).toHaveLength(100_000);
    await vi.waitFor(() => expect(a.backlog()).toBe(0));
  });
});
