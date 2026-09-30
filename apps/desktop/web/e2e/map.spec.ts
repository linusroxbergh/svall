import { FAKE_CLAUDE, expect, test } from './fixtures.js';
import type { Page } from '@playwright/test';
import { cardScale, labelScale } from '../src/map/layout.js';
import { theme } from '../src/theme.js';

type Layout = { scale: number; tile: number; ox: number; oy: number };
type Dump = {
  scale: number;
  islands: { id: string; x: number; y: number; w: number; h: number }[];
  tokens: { id: string; cell: { x: number; y: number }; status: string }[];
};
type MapHandle = { layout(): Layout; dump(): Dump };

const layoutOf = (page: Page) => page.evaluate(() => (window as unknown as { __map: MapHandle }).__map.layout());
const dump = (page: Page) => page.evaluate(() => (window as unknown as { __map: MapHandle }).__map.dump());

// the fit ease keeps shifting the layout for a few frames after the view opens
const settle = (page: Page) => page.waitForFunction(() => {
  const m = (window as unknown as { __map: MapHandle }).__map;
  const before = JSON.stringify(m.layout());
  return new Promise<boolean>((done) => setTimeout(() => done(before === JSON.stringify(m.layout())), 100));
});

// the fit centres the islands in the window, so the water to press is the strip above them
async function dragSea(page: Page, dx: number, dy: number) {
  const sea = (await page.locator('.map-sea').boundingBox())!;
  const cx = sea.x + sea.width / 2, cy = sea.y + 64;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx / 2, cy + dy / 2, { steps: 4 });
  await page.mouse.move(cx + dx, cy + dy, { steps: 4 });
  await page.mouse.up();
}

test('renders the fleet and follows agent status', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('map'), seed: 3 });
  const shell = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'plain' });
  const agent = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'agent', command: FAKE_CLAUDE });
  await svall.open('map');

  await expect(page.getByTestId(`island-label-${island.id}`)).toContainText(island.name);
  const svg = page.getByTestId(`island-${island.id}`);
  await expect(svg).toBeVisible();
  expect(await svg.locator('path').count()).toBeGreaterThanOrEqual(5);

  const shellTok = page.getByTestId(`token-${shell.id}`);
  await expect(shellTok).toHaveAttribute('data-status', 'shell');
  await expect(shellTok.locator('.portrait')).toHaveAttribute('src', `./animals/${shell.portrait}.svg`);
  const shellCell = await svall.cellOf(shell.id);
  await expect.poll(async () => (await dump(page)).tokens.find((t) => t.id === shell.id)?.cell)
    .toEqual({ x: island.position.x + shellCell.x, y: island.position.y + shellCell.y });

  const agentTok = page.getByTestId(`token-${agent.id}`);
  await expect(agentTok).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });

  await svall.api.call('char.run', { id: agent.id, text: 'block', enter: true });
  await expect(agentTok).toHaveAttribute('data-status', 'blocked', { timeout: 15_000 });
  await expect(agentTok.locator('.gem')).toHaveText('!');

  await svall.api.call('char.run', { id: agent.id, text: 'go', enter: true });
  await expect(agentTok).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await expect(agentTok).toHaveAttribute('data-unread', 'true');
  await expect(agentTok.locator('.gem')).toHaveText('✓');

  const scale = (await dump(page)).scale;
  expect(scale).toBeGreaterThanOrEqual(0.5);
  expect(scale).toBeLessThanOrEqual(1.5);
});

test('pans by dragging water and by wheel, clamped', async ({ page, svall }) => {
  // five islands sixteen cells apart reach far wider than the map, so the fit hits theme.scale.min
  // and the world overflows on x, leaving something to pan
  const y = 300;
  for (let i = 0; i < 5; i++) {
    await svall.api.call('island.create', { name: svall.uniq(`pan${i}`), position: { x: i * 16, y } });
  }
  await svall.open('map');
  await settle(page);
  expect((await layoutOf(page)).scale).toBeCloseTo(0.42, 5);

  const start = (await layoutOf(page)).ox;
  await dragSea(page, -200, 0);
  await expect.poll(async () => (await layoutOf(page)).ox).toBeLessThan(start);

  // the drag already sits on the left clamp, so the wheel only has room back the other way
  const dragged = (await layoutOf(page)).ox;
  await page.mouse.wheel(-300, 0);
  await expect.poll(async () => (await layoutOf(page)).ox).toBeGreaterThan(dragged);

  // a drag far past the world's edge stops at theme.panMargin; a second one cannot move it further
  await dragSea(page, 4000, 0);
  await settle(page);
  const clamped = (await layoutOf(page)).ox;
  await dragSea(page, 4000, 0);
  await settle(page);
  expect((await layoutOf(page)).ox).toBeCloseTo(clamped, 5);
});

test('a click on the sea deselects and closes the card', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('sea'), position: { x: 0, y: 200 } });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'c' });
  await svall.open('map');
  await settle(page);
  const l = await layoutOf(page);
  const cs = l.tile * l.scale;
  const p = await page.evaluate((cell) => (window as unknown as { __map: { screenOf(c: { x: number; y: number }): { x: number; y: number } } }).__map.screenOf(cell),
    { x: island.position.x + c.cell.x, y: island.position.y + c.cell.y });
  const box = (await page.getByTestId('map').boundingBox())!;
  await page.mouse.dblclick(box.x + p.x + cs / 2, box.y + p.y + cs / 2);
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-char', c.id);

  const sea = (await page.locator('.map-sea').boundingBox())!;
  await page.mouse.click(sea.x + 8, sea.y + 8);
  await expect(page.getByTestId('terminal-card')).toHaveCount(0);
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
});

test('+ New stays live while the pointer rests on it', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('new'), position: { x: 0, y: 400 } });
  await svall.open('map');
  await settle(page);

  const svg = page.getByTestId(`island-${island.id}`);
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const add = page.getByTestId(`island-new-${island.id}`);
  const target = (await add.boundingBox())!;
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  // the island's hot grace is 400ms; the button must still take the click well past it
  await page.waitForTimeout(700);
  await add.click();
  await expect(page.locator('.tok')).toHaveCount(1);
});

test('makes an island by double-clicking the sea', async ({ page, svall }) => {
  await svall.api.call('island.create', { name: svall.uniq('seed'), position: { x: 0, y: 600 } });
  await svall.open('map');
  await settle(page);

  const before = Object.keys((await svall.api.call('state.get', {})).islands).length;
  const sea = (await page.locator('.map-sea').boundingBox())!;
  await page.mouse.dblclick(sea.x + 40, sea.y + sea.height - 40);
  await expect.poll(async () => Object.keys((await svall.api.call('state.get', {})).islands).length).toBe(before + 1);
  await expect(page.getByTestId('side-island-card')).toBeVisible();
});

test('makes an island from the mission control row and from the sidebar', async ({ page, svall }) => {
  await svall.api.call('island.create', { name: svall.uniq('btn'), position: { x: 0, y: 1300 } });
  await svall.open('map');
  await settle(page);
  const count = async () => Object.keys((await svall.api.call('state.get', {})).islands).length;

  const before = await count();
  await page.getByTestId('home-new-island').click();
  await expect.poll(count).toBe(before + 1);
  await expect(page.getByTestId('side-island-card')).toBeVisible();

  await page.getByTestId('sidebar-new-island').click();
  await expect.poll(count).toBe(before + 2);
});

test('the side card stays collapsed until it is opened again', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('col'), position: { x: 0, y: 800 } });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
  const b = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'b' });
  await svall.open('map');
  await settle(page);

  await page.getByTestId(`token-${a.id}`).click();
  await expect(page.getByTestId('side-card')).toBeVisible();
  await page.getByTestId('side-collapse').click();
  await expect(page.getByTestId('side-card')).toHaveCount(0);

  // picking another character must not bring it back
  await page.getByTestId(`token-${b.id}`).click();
  await expect(page.getByTestId('side-card')).toHaveCount(0);
  await expect(page.getByTestId('side-show')).toBeVisible();

  await page.getByTestId('side-show').click();
  await expect(page.getByTestId('side-card')).toBeVisible();
  await expect(page.getByTestId('side-name')).toHaveValue('b');
});

// a press on the map calls preventDefault, so the browser moves no focus and the field hears no blur of its own
test('a rename left by a press on another character is saved to the one it was typed for', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('rename'), position: { x: 0, y: 800 } });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
  const b = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'b' });
  await svall.open('map');
  await settle(page);

  await page.getByTestId(`token-${a.id}`).click();
  await page.getByTestId('side-name').fill('auth fix');
  await page.getByTestId(`token-${b.id}`).click();
  await expect(page.getByTestId('side-name')).toHaveValue('b');
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[a.id].name).toBe('auth fix');
  expect((await svall.api.call('state.get', {})).characters[b.id].name).toBe('b');
});

test('double-clicking an island opens its card, collapsed or not', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('dbl'), position: { x: 0, y: 1000 } });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'aboard' });
  await svall.open('map');
  await settle(page);

  await page.getByTestId(`token-${c.id}`).click();
  await page.getByTestId('side-collapse').click();
  await expect(page.getByTestId('side-card')).toHaveCount(0);

  await page.getByTestId(`island-label-${island.id}`).dblclick();
  const card = page.getByTestId('side-island-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('side-island-name')).toHaveValue(island.name);
});

test('an island folds to its label, in step with the sidebar', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('fold'), position: { x: 0, y: 1100 } });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'folded' });
  await svall.open('map');
  await settle(page);

  await page.getByTestId(`island-toggle-${island.id}`).click();
  await expect(page.getByTestId(`island-${island.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`token-${c.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`island-label-${island.id}`)).toContainText(island.name);
  await expect(page.getByTestId(`sb-island-${island.id}`)).toHaveAttribute('data-open', 'false');

  await page.getByTestId(`sb-island-toggle-${island.id}`).click();
  await expect(page.getByTestId(`island-${island.id}`)).toBeVisible();
  await expect(page.getByTestId(`token-${c.id}`)).toBeVisible();
});

test('the arrange button packs the fleet together and the map zooms into it', async ({ page, svall }) => {
  const a = await svall.api.call('island.create', { name: svall.uniq('near'), position: { x: 0, y: 0 }, size: { w: 12, h: 9 } });
  const b = await svall.api.call('island.create', { name: svall.uniq('far'), position: { x: 40, y: 0 }, size: { w: 12, h: 9 } });
  const folded = await svall.api.call('island.create', { name: svall.uniq('folded'), position: { x: 0, y: 30 } });
  await svall.api.call('island.update', { id: folded.id, collapsed: true });
  await svall.api.call('char.create', { islandId: a.id, cwd: '/tmp', name: 'aboard' });
  await svall.open('map');
  await settle(page);
  const spread = await dump(page);

  await page.getByTestId('home-arrange').click();
  await expect.poll(async () => (await dump(page)).islands.find((i) => i.id === b.id)?.x).toBeLessThan(20);
  await settle(page);
  const packed = await dump(page);

  const width = (d: Dump) => Math.max(...d.islands.map((i) => i.x + i.w)) - Math.min(...d.islands.map((i) => i.x));
  expect(width(packed)).toBeLessThan(width(spread));
  expect(packed.islands.find((i) => i.id === a.id)!.w).toBeLessThan(12);
  expect(packed.scale).toBeGreaterThan(spread.scale);
  await expect(page.getByTestId(`island-${folded.id}`)).toHaveCount(0);
});

test('the fleet arranges itself when the map is in full view again, and when the window settles', async ({ page, svall }) => {
  const near = await svall.api.call('island.create', { name: svall.uniq('near'), position: { x: 0, y: 0 }, size: { w: 12, h: 9 } });
  const far = await svall.api.call('island.create', { name: svall.uniq('far'), position: { x: 40, y: 0 }, size: { w: 12, h: 9 } });
  const c = await svall.api.call('char.create', { islandId: near.id, cwd: '/tmp', name: 'aboard' });
  await svall.open('map');
  await settle(page);
  const farX = async () => (await dump(page)).islands.find((i) => i.id === far.id)?.x;
  const spreadAgain = async () => {
    await svall.api.call('island.update', { id: far.id, position: { x: 40, y: 0 } });
    await expect.poll(farX).toBe(40);
  };

  // a full card hides the map; leaving it packs the fleet into the room the map has again
  await page.getByTestId(`sb-char-${c.id}`).click();
  await page.getByTestId(`sb-char-${c.id}`).click();
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-size', 'full');
  await page.keyboard.press('Meta+Enter');
  await expect.poll(farX).toBeLessThan(20);

  await spreadAgain();
  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(farX).toBeLessThan(20);

  // switched off, the fleet stays where the user put it
  await spreadAgain();
  await page.keyboard.press('Meta+,');
  await page.getByTestId('set-auto-arrange').click();
  await expect(page.getByTestId('set-auto-arrange')).toHaveAttribute('aria-checked', 'false');
  await page.setViewportSize({ width: 1100, height: 800 });
  // well past the arrange debounce, so the fleet has had every chance to move
  await page.waitForTimeout(700);
  expect(await farX()).toBe(40);
});

test('a narrow map behind an open terminal does not save a tall fleet arrangement', async ({ page, svall }) => {
  const near = await svall.api.call('island.create', { name: svall.uniq('near'), position: { x: 0, y: 0 } });
  const far = await svall.api.call('island.create', { name: svall.uniq('far'), position: { x: 40, y: 0 } });
  const c = await svall.api.call('char.create', { islandId: near.id, cwd: '/tmp', name: 'aboard' });
  await svall.open('map');
  await page.getByTestId(`sb-char-${c.id}`).click();
  await page.getByTestId(`sb-char-${c.id}`).click();
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-size', 'half');
  await expect(page.getByTestId('side-card')).toBeVisible();

  await page.setViewportSize({ width: 700, height: 800 });
  await expect.poll(() => page.getByTestId('map').evaluate((el) => el.clientWidth)).toBeLessThan(200);
  await page.waitForTimeout(theme.autoArrangeMs + 200);
  expect((await svall.api.call('state.get', {})).islands[far.id].position.x).toBe(40);

  // A later resize with enough room still arranges the fleet.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await svall.api.call('state.get', {})).islands[far.id].position.x).toBeLessThan(20);
});

// a card keeps its screen size at any zoom, so it reaches further over the world the further the map is zoomed
// out; what the arrangement owns is the water between islands — a card must never reach another island's label
test('an arranged fleet keeps every label pill clear of the cards around it', async ({ page, svall }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  const crewed = await svall.api.call('island.create', { name: svall.uniq('animalplayground'), position: { x: 0, y: 0 } });
  const below = await svall.api.call('island.create', { name: svall.uniq('documentation'), position: { x: 0, y: 40 } });
  const chars = [];
  for (const island of [crewed, crewed, crewed, below]) chars.push(await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp' }));
  await svall.open('map');
  await settle(page);

  await page.getByTestId('home-arrange').click();
  await expect.poll(async () => new Set((await dump(page)).islands.map((i) => i.y)).size).toBe(2);
  await settle(page);

  const boxes = await page.evaluate(() => {
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-testid') ?? '', x: r.x, y: r.y, w: r.width, h: r.height }; };
    return {
      labels: [...document.querySelectorAll('.map-world .ilabel')].map(box),
      cards: [...document.querySelectorAll('.map-world .tok')].map(box),
    };
  });
  expect(boxes.labels).toHaveLength(2);
  expect(boxes.cards).toHaveLength(4);
  const islandOf = new Map(chars.map((c) => [`token-${c.id}`, `island-label-${c.islandId}`]));
  for (const l of boxes.labels) {
    for (const c of boxes.cards) {
      if (islandOf.get(c.id) === l.id) continue;
      const clear = l.x + l.w <= c.x || c.x + c.w <= l.x || l.y + l.h <= c.y || c.y + c.h <= l.y;
      expect(clear, `label ${l.id} overlaps card ${c.id}`).toBe(true);
    }
  }
});

test('a token shows four links, and past that three and a count of the rest', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('rail'), seed: 3 });
  const links = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'other' as const, ref: `https://example.com/${i}`, label: `link ${i}`, source: 'manual' as const }));
  const four = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'four' });
  const ten = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'ten' });
  await svall.api.call('char.update', { id: four.id, context: links(4) });
  await svall.api.call('char.update', { id: ten.id, context: links(10) });
  await svall.open('map');

  await expect(page.getByTestId(`token-${four.id}`).locator('.chip.lk')).toHaveCount(4);
  await expect(page.getByTestId(`token-more-${four.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`token-${ten.id}`).locator('.chip.lk')).toHaveCount(3);
  await expect(page.getByTestId(`token-more-${ten.id}`)).toHaveText('+7');
});

test('a crowded crew never covers the card beside it, link rails and all', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('crowd'), seed: 1, position: { x: 0, y: 0 } });
  for (let i = 0; i < 6; i++) {
    const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: `c${i}` });
    // the rail of link chips hangs off the card's right, reaching further than the card itself
    await svall.api.call('char.update', { id: c.id, context: [{ kind: 'other', ref: `https://example.com/${i}`, label: 'x', source: 'manual' }] });
  }
  // a second island far down the map pushes the fit past the scale where cards stop shrinking, which is
  // where a card stands largest against the cells and two of them come closest to touching
  await svall.api.call('island.create', { name: svall.uniq('far'), seed: 2, position: { x: 0, y: 40 } });
  await svall.open('map');
  await settle(page);
  expect((await layoutOf(page)).scale).toBeLessThanOrEqual(theme.token.floor);

  const boxes = await page.evaluate(() => Array.from(document.querySelectorAll('.tok')).map((el) => {
    const card = el.querySelector('.card')!.getBoundingClientRect();
    const rail = el.querySelector('.rail')?.getBoundingClientRect() ?? card;
    return {
      id: (el as HTMLElement).dataset.testid ?? '',
      x: Math.min(card.x, rail.x), y: Math.min(card.y, rail.y),
      right: Math.max(card.right, rail.right), bottom: Math.max(card.bottom, rail.bottom),
    };
  }));
  expect(boxes).toHaveLength(6);
  for (const a of boxes) for (const b of boxes) {
    if (a.id === b.id) continue;
    const clear = a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y;
    expect(clear, `${a.id} covers ${b.id}`).toBe(true);
  }
});

test('mission control cards stand as big as island cards once the fleet zooms the map out', async ({ page, svall }) => {
  const mc = await svall.api.call('char.create', { islandId: 'home', cwd: '/tmp', name: 'mc' });
  const island = await svall.api.call('island.create', { name: svall.uniq('near'), seed: 1, position: { x: 0, y: 0 } });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'isl' });
  // a far island zooms the map out past the scale where cards stop keeping their size
  await svall.api.call('island.create', { name: svall.uniq('far'), seed: 2, position: { x: 0, y: 40 } });
  await svall.open('map');
  await settle(page);
  expect((await layoutOf(page)).scale).toBeLessThan(theme.token.floor);
  const [home, own] = await Promise.all([mc.id, c.id].map(async (id) => (await page.getByTestId(`token-${id}`).locator('.card').boundingBox())!));
  expect(own.width).toBeLessThan(80);
  expect(Math.abs(home.width - own.width)).toBeLessThan(1);
  expect(Math.abs(home.height - own.height)).toBeLessThan(1);
});

test('a zoom rescales cards and label pills, and restyles nothing inside them', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('zoom'), seed: 4, position: { x: 0, y: 0 } });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'zoomed' });
  await svall.open('map');
  await settle(page);
  // a zoom changes these values every frame and restyles every element holding one, so only the card,
  // the pill and the grid may hold them
  const read = () => page.evaluate(({ tok, label }) => {
    const style = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim();
    const t = document.querySelector(`[data-testid="${tok}"]`)!, card = t.querySelector<HTMLElement>('.card')!;
    const pill = document.querySelector<HTMLElement>(`[data-testid="${label}"]`)!;
    // offsetWidth is the untransformed width, rounded to a whole pixel
    return {
      card: card.getBoundingClientRect().width / card.offsetWidth,
      pill: pill.getBoundingClientRect().width / pill.offsetWidth,
      inside: [style(card, '--k'), style(pill.querySelector('b')!, '--lk')],
      mapCell: style(document.querySelector('.map')!, '--cell'), rootCell: style(document.documentElement, '--cell'),
      gridCell: parseFloat(style(document.querySelector('.map-grid')!, '--cell')),
    };
  }, { tok: `token-${c.id}`, label: `island-label-${island.id}` });

  const near = (await layoutOf(page)).scale;
  expect(near).toBeGreaterThan(1);
  const up = await read();
  expect(up.card).toBeCloseTo(cardScale(near), 2);
  expect(up.pill).toBeCloseTo(labelScale(near), 2);
  expect(up.inside).toEqual(['1', '1']);
  expect(up.mapCell).toBe(up.rootCell);
  expect(up.gridCell).toBeCloseTo(theme.cell * near, 3);

  // a far island zooms the map out past the scale where cards stop keeping their size
  await svall.api.call('island.create', { name: svall.uniq('far'), seed: 5, position: { x: 0, y: 40 } });
  await expect.poll(async () => (await layoutOf(page)).scale).toBeLessThan(theme.token.floor);
  await settle(page);
  const far = (await layoutOf(page)).scale;
  const down = await read();
  expect(down.card).toBeCloseTo(cardScale(far), 2);
  expect(down.pill).toBeCloseTo(labelScale(far), 2);
});
