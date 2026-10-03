import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ProtocolMismatch } from '@svall/svalld/fleets';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { Client } from '../src/client.js';

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
