import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ProtocolMismatch } from '@svall/svalld/fleets';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import { PART_BYTES, PROTOCOL_VERSION } from '@svall/protocol';
import { ApiError, Client } from '../src/client.js';

afterEach(cleanHomes);

describe('Client', () => {
  it('rejects pending calls when svalld closes the connection', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => {
      let authed = false;
      ws.on('message', () => {
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
        ws.close();
      });
    });
    const home = makeHome();
    const { port } = wss.address() as { port: number };
    fs.writeFileSync(path.join(home, 'port'), String(port));
    fs.writeFileSync(path.join(home, 'token'), 't');

    const client = await Client.connect(home);
    await expect(client.call('state.get', {})).rejects.toThrow(/connection closed/);
    await new Promise((r) => wss.close(r));
  });

  it('refuses a daemon that speaks another protocol', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => ws.once('message', () => ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION + 1 } }))));
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'port'), String((wss.address() as { port: number }).port));
    fs.writeFileSync(path.join(home, 'token'), 't');

    const err = await Client.connect(home).then(() => new Error('connected'), (e: Error) => e);
    expect(err).toBeInstanceOf(ProtocolMismatch);
    expect(err.message).toMatch(new RegExp(`svalld of ${home} speaks protocol ${PROTOCOL_VERSION + 1} and this build speaks ${PROTOCOL_VERSION}`));
    expect(err.message).toMatch(new RegExp(`: quit and reopen Svall, or restart the svalld serving ${home}$`));

    // a profile's own home names that profile's launchd agent
    const work = path.join(os.homedir(), '.svall-work');
    fs.mkdirSync(work);
    for (const f of ['port', 'token']) fs.copyFileSync(path.join(home, f), path.join(work, f));
    await expect(Client.connect(work)).rejects.toThrow('restart it with `launchctl kickstart -k gui/$(id -u)/io.github.linusroxbergh.svall.svalld.work`');
    fs.rmSync(work, { recursive: true });
    await new Promise((r) => wss.close(r));
  });

  // the daemon restarting between a command's two calls must not leave the second waiting out its whole timeout
  it('fails a call at once once svalld has closed the connection', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => ws.once('message', () => {
      ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }));
      ws.close();
    }));
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'port'), String((wss.address() as { port: number }).port));
    fs.writeFileSync(path.join(home, 'token'), 't');

    const client = await Client.connect(home);
    await new Promise<void>((r) => (client as unknown as { ws: WebSocket }).ws.once('close', () => r()));
    const unsettled = new Promise((r) => setTimeout(() => r('still waiting'), 1000));
    await expect(Promise.race([client.call('state.get', {}), unsettled])).rejects.toThrow('svalld connection closed');
    await new Promise((r) => wss.close(r));
  });

  it('sends a call too large for one socket message in parts, and hands on the structured half of a refusal', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    const frames: number[] = [];
    wss.on('connection', (ws) => {
      let authed = false;
      const parts: Buffer[] = [];
      ws.on('message', (raw) => {
        frames.push(raw.toString().length);
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
        const msg = JSON.parse(raw.toString());
        let req = msg;
        if (msg.part) {
          parts.push(Buffer.from(msg.part.data, 'base64'));
          if (parts.length < msg.part.count) return;
          req = JSON.parse(Buffer.concat(parts).toString('utf8'));
        }
        const size = JSON.stringify(req.params).length;
        ws.send(JSON.stringify({ id: req.id, error: { code: 'blocked', message: `${size} bytes`, data: { blockers: [{ code: 'shell_busy', message: 'vite' }] } } }));
      });
    });
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'port'), String((wss.address() as { port: number }).port));
    fs.writeFileSync(path.join(home, 'token'), 't');

    const client = await Client.connect(home);
    const pad = 'ü'.repeat(5 * 1024 * 1024);
    const refused = await client.call('state.get', { pad } as never).then(() => undefined, (e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: 'blocked', data: { blockers: [{ code: 'shell_busy', message: 'vite' }] } });
    expect((refused as Error).message).toBe(`${JSON.stringify({ pad }).length} bytes`);
    // the token, then at least three parts, none of them near the daemon's 8 MiB cap
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...frames)).toBeLessThan(Math.ceil(PART_BYTES / 3) * 4 + 200);
    client.close();
    await new Promise((r) => wss.close(r));
  });

  it('reads an answer as large as a request may be, and one larger as a refusal, never as a dropped link to call again', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    const big = 'm'.repeat(101 * 1024 * 1024);
    wss.on('connection', (ws) => {
      let authed = false;
      ws.on('message', (raw) => {
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true } })); return; }
        const req = JSON.parse(raw.toString()) as { id: number };
        ws.send(`{"id":${req.id},"result":{"manifest":"${big}"}}`);
      });
    });
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
    // past ws's 100 MiB default, and within what a request in parts may come to
    const whole = await Client.connectEndpoint({ url, token: 't' });
    expect(((await whole.call('state.get', {})) as unknown as { manifest: string }).manifest.length).toBe(big.length);
    whole.close();
    const small = await Client.connectEndpoint({ url, token: 't', maxPayload: 1024 * 1024 });
    const refused = await small.call('state.get', {}).then(() => undefined, (e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: 'too_large' });
    await new Promise((r) => wss.close(r));
  }, 30_000);

  it('reads a request svalld closes on as too large as its refusal, never as a dropped link to call again', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => {
      let authed = false;
      ws.on('message', () => {
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true } })); return; }
        ws.close(1009, 'request too large');
      });
    });
    const client = await Client.connectEndpoint({ url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, token: 't' });
    const refused = await client.call('state.get', {}).then(() => undefined, (e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: 'too_large', message: expect.stringContaining('request too large') });
    await new Promise((r) => wss.close(r));
  });

  it('hands each event the daemon pushes to whoever listens, and keeps answers to their calls', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => {
      let authed = false;
      ws.on('message', (raw) => {
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
        const req = JSON.parse(raw.toString()) as { id: number };
        ws.send(JSON.stringify({ event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'freeze' } }));
        ws.send(JSON.stringify({ id: req.id, result: { answered: true } }));
      });
    });
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'port'), String((wss.address() as { port: number }).port));
    fs.writeFileSync(path.join(home, 'token'), 't');

    const client = await Client.connect(home);
    const seen: unknown[] = [];
    const stop = client.onEvent((e) => seen.push(e));
    expect(await client.call('state.get', {})).toEqual({ answered: true });
    expect(seen).toEqual([{ event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'freeze' } }]);
    stop();
    await client.call('state.get', {});
    expect(seen).toHaveLength(1);
    client.close();
    await new Promise((r) => wss.close(r));
  });

  it('keeps no process alive for a call still waiting on its answer', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => {
      ws.once('message', () => ws.send(JSON.stringify({ id: 0, result: { ok: true } })));
    });
    const client = await Client.connectEndpoint({ url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, token: 't' });
    const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timers();
    const waiting = client.call('state.get', {}).catch((e: unknown) => e);
    expect(timers()).toBe(before);
    client.close();
    expect(await waiting).toMatchObject({ message: 'svalld connection closed' });
    await new Promise((r) => wss.close(r));
  });

  it('closes its socket when svalld never answers the handshake', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    let received!: () => void;
    const tokenSent = new Promise<void>((r) => { received = r; });
    const closed = new Promise<void>((r) => wss.on('connection', (ws) => { ws.once('message', () => received()); ws.once('close', () => r()); }));
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'port'), String((wss.address() as { port: number }).port));
    fs.writeFileSync(path.join(home, 'token'), 't');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const connecting = expect(Client.connect(home)).rejects.toThrow(/did not answer the handshake/);
      await tokenSent;
      await vi.advanceTimersByTimeAsync(10_000);
      await connecting;
    } finally {
      vi.useRealTimers();
    }
    await closed;
    await new Promise((r) => wss.close(r));
  });
});
