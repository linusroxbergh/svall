import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { LimitHit } from '@svall/protocol';
import { startApi } from '../src/api/server.js';
import { silentLogger } from '../src/log.js';
import { Phones } from '../src/phones.js';
import { PushStore } from '../src/push/store.js';
import { Store } from '../src/store.js';
import { cleanHomes, makeHome, stubFleets, stubLoad, stubMobile, stubSystemInfo, stubUsage } from './helpers.js';

afterEach(cleanHomes);

const HIT: LimitHit = { machine: 'aaaaaaaa-0000-4000-8000-000000000000', name: 'studio', hits: 2, at: 1_700_000_000_000 } as LimitHit;

it('tells a desktop window of each limit hit, and takes none once it has closed', async () => {
  const home = makeHome();
  let tell: ((hit: LimitHit) => void) | undefined;
  const api = await startApi({
    host: '127.0.0.1', port: 0, token: 'secret', pass: 'p4ss', store: Store.load(path.join(home, 'state.json'), () => {}), fleet: {} as never, fleets: stubFleets,
    terminals: { closeAll() {} } as never, workspace: { unwatchAll() {} } as never, usage: stubUsage, load: stubLoad, mobileControl: stubMobile, log: silentLogger,
    push: new PushStore(path.join(home, 'push.json'), () => {}), vapidPublicKey: 'k', phones: new Phones(), claude: { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') }, systemInfo: stubSystemInfo,
    onLimitHit: (t) => { tell = t; return () => { tell = undefined; }; },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${api.port}`);
  const heard = new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ token: 'secret' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { id?: number; event?: string; data?: unknown };
      if (m.id === 0) tell!(HIT);
      if (m.event === 'machines.limitHit') resolve(m.data);
    });
  });
  expect(await heard).toEqual(HIT);
  ws.close();
  await api.close();
  expect(tell).toBeUndefined();
});
