import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ISLET } from '../src/map/resources.js';
import { RESOURCE_COL_RANGE } from '../src/store/index.js';
import { theme } from '../src/theme.js';
import { expect, setMapWidth, test } from './fixtures.js';

// a five-slot home and the islet fit as a centred pair from 1064px of map; this leaves 1841px past the sidebar
const WIDE = { width: 2100, height: 1000 };

// typing into a doc's text waits for CodeMirror to hold the keys
async function editorHasKeys(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? '')).toContain('cm-content');
}

// the row wraps to as many lines as it needs, and every one of them stays out from under the shelf
async function rowClearOfShelf(page: Page): Promise<void> {
  const shelf = (await page.getByTestId('resources-shelf').boundingBox())!;
  const row = (await page.getByTestId('home-row').boundingBox())!;
  expect(shelf.y + shelf.height).toBeLessThanOrEqual(row.y);
}

test('the islet stands right of mission control and the lighthouse on it opens the shelf on all resources', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  const islet = page.getByTestId('resources-islet');
  await expect(islet).toBeVisible();
  // both boxes carry 132px of drawing room on each side; a cell of water lies between the two pieces of land
  const home = await page.getByTestId('island-home').boundingBox();
  const land = await islet.boundingBox();
  expect(Math.abs(land!.x - (home!.x + home!.width - 132 + 44 - 132))).toBeLessThan(2);
  const tower = (await page.getByTestId('resources-lighthouse').boundingBox())!;
  expect(Math.abs(tower.x + tower.width / 2 - (land!.x + land!.width / 2))).toBeLessThan(2);
  await expect(page.getByTestId('resources-pill')).toContainText('resources');

  await page.getByTestId('resources-lighthouse').click();
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  await expect(page.getByTestId('resources-what-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('resources-lighthouse')).toHaveAttribute('data-selected', 'true');
  await rowClearOfShelf(page);
});

test('the lighthouse wears the map’s grain, cut to its outline, and it rises with the tower', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  const tower = page.getByTestId('resources-lighthouse');
  const grain = tower.locator('.res-tower-grain');
  const img = tower.locator('img');
  const apart = async () => {
    const [g, i] = [(await grain.boundingBox())!, (await img.boundingBox())!];
    return Math.max(...(['x', 'y', 'width', 'height'] as const).map((k) => Math.abs(g[k] - i[k])));
  };
  expect(await apart()).toBeLessThan(1);
  await expect(grain).toHaveCSS('mask-image', /lighthouse2\.svg/);
  await expect(grain).not.toHaveCSS('background-image', 'none');
  await expect(grain).toHaveCSS('pointer-events', 'none');
  // the tower lifts on hover; the grain lifts with it
  await tower.hover();
  await expect(img).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -3)');
  await expect(grain).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -3)');
  expect(await apart()).toBeLessThan(1);
});

test('a narrow map keeps the islet at 0.65 of its size or more, clear of the edge and of mission control, which shrinks for it', async ({ page, svall }) => {
  // five crew make home 17 cells wide
  for (let n = 0; n < 5; n++) await svall.api.call('char.create', { islandId: 'home', cwd: '/tmp', name: `crew-${n}` });
  await svall.open('map');
  // the land in each drawing lies a pad in from its edges, at the scale it is drawn
  const pair = async () => {
    const [map, home, islet, row] = await Promise.all(['map', 'island-home', 'resources-islet', 'home-row'].map(async (id) => (await page.getByTestId(id).boundingBox())!));
    const homeScale = home.width / (17 * theme.cell + 2 * theme.pad), scale = islet.width / (ISLET.w + 2 * theme.pad);
    return { homeScale, scale, homeLeft: home.x + theme.pad * homeScale - map.x, homeRight: home.x + home.width - theme.pad * homeScale,
      isletLeft: islet.x + theme.pad * scale, isletRight: islet.x + islet.width - theme.pad * scale - map.x, mapW: map.width,
      rowLeft: row.x - map.x, rowRight: row.x + row.width };
  };
  let wide = 1;
  for (const w of [1000, 860, 700]) {
    await setMapWidth(page, w);
    // the pair takes its place a frame after the map takes its width
    await expect.poll(async () => (await pair()).isletRight).toBeLessThanOrEqual(w);
    const p = await pair();
    expect(p.scale).toBeGreaterThanOrEqual(0.65 - 1e-3);
    expect(p.homeLeft).toBeGreaterThanOrEqual(0);
    expect(p.homeRight).toBeLessThanOrEqual(p.isletLeft);
    expect(p.isletRight).toBeLessThanOrEqual(p.mapW);
    // the label row keeps its size, and wraps rather than leave the map or run into the lighthouse
    expect(p.rowLeft).toBeGreaterThanOrEqual(0);
    expect(p.rowRight).toBeLessThanOrEqual(p.isletLeft);
    expect(p.homeScale).toBeLessThanOrEqual(wide);
    wide = p.homeScale;
  }
  expect(wide).toBeLessThan(0.75);

  await page.getByTestId('resources-lighthouse').click();
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  await rowClearOfShelf(page);
});

test('a folded mission control leaves only the pill, at the end of its row', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId('home-toggle').click();
  await expect(page.getByTestId('resources-islet')).toHaveCount(0);
  await page.getByTestId('home-row').getByTestId('resources-pill').click();
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  await rowClearOfShelf(page);
  // the fold is the fleet's, so it is put back for whatever runs next
  await page.getByTestId('home-toggle').click();
  await expect(page.getByTestId('resources-islet')).toBeVisible();
});

test('a skill opens in the editor, is edited, and is saved to the run’s Claude dir', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-what-skills').click();
  await page.getByTestId('resources-item-skills-ship-it').click();
  await expect(page.getByTestId('resources-editor-path')).toContainText('skills/ship-it/SKILL.md');
  const editor = page.getByTestId('editor');
  await expect(editor.locator('.cm-content')).toContainText('# Ship it');
  await editor.getByRole('button', { name: 'Preview' }).click();
  await expect(editor.getByTestId('markdown-preview').getByRole('heading', { name: 'Ship it' })).toBeVisible();
  await editor.getByRole('button', { name: 'Text' }).click();
  await editor.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('Never on a Friday.');
  await expect(page.getByTestId('resources-item-skills-ship-it')).toHaveAttribute('data-dirty', 'true');

  // another file takes the pane; the first keeps its edits and its mark
  await page.getByTestId('resources-what-all').click();
  await page.getByTestId('resources-item-instructions-CLAUDE.md').click();
  await expect(page.getByTestId('resources-editor-path')).toContainText('CLAUDE.md');
  await expect(page.getByTestId('resources-item-skills-ship-it')).toHaveAttribute('data-dirty', 'true');

  await page.getByTestId('resources-item-skills-ship-it').click();
  await expect(editor.locator('.cm-content')).toContainText('Never on a Friday.');
  await page.keyboard.press('Meta+s');
  await expect(page.getByTestId('resources-item-skills-ship-it')).toHaveAttribute('data-dirty', 'false');
  await expect.poll(() => fs.readFileSync(path.join(svall.home, 'claude/skills/ship-it/SKILL.md'), 'utf8')).toContain('Never on a Friday.');
});

test('a kind with one file shows it with no row to press', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-what-instructions').click();
  await expect(page.getByTestId('resources-editor-path')).toContainText('CLAUDE.md');
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('# e2e');
});

test('the tree folds a tier a folder, lists its sources when picked, and a character’s chain leads to its island', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  const island = await svall.api.call('island.create', { name: svall.uniq('isle') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: os.tmpdir() });
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();

  // Global and Fleet stand open by default; the other three are one row each
  await expect(page.getByTestId('resources-group-global')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('resources-group-fleet')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('resources-group-character')).toHaveAttribute('aria-expanded', 'false');

  // a press on the folder picks the tier, and the list is its sources; the caret opens it
  const docs = path.join(svall.home, 'docs');
  const charRoot = `r:${path.join(docs, 'characters', c.id)}`;
  await page.getByTestId('resources-group-character').click();
  await expect(page.getByTestId('resources-group-character')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('resources-group-character')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId(`resources-list-source-${charRoot}`)).toContainText(c.name);
  await page.getByTestId('resources-caret-character').click();
  await expect(page.getByTestId('resources-group-character')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId(`resources-where-${charRoot}`).click();
  await expect(page.getByTestId(`resources-where-${charRoot}`)).toHaveAttribute('aria-pressed', 'true');
  // only the kinds the source holds are offered, and the whole of it is listed
  await expect(page.getByTestId('resources-what-skills')).toHaveCount(0);
  await expect(page.getByTestId('resources-what-docs')).toBeVisible();
  await expect(page.getByTestId('resources-what-all')).toHaveAttribute('aria-pressed', 'true');

  await expect(page.getByTestId('resources-chain')).toContainText(`${c.name} reads, in order`);
  await page.getByTestId('resources-chip-island').click();
  await expect(page.getByTestId('resources-group-island')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId(`resources-where-r:${path.join(docs, 'islands', island.id)}`)).toHaveAttribute('aria-pressed', 'true');

  // the open groups survive a reload
  await page.reload();
  await page.waitForFunction(() => '__map' in window);
  await page.getByTestId('resources-lighthouse').click();
  await expect(page.getByTestId('resources-group-island')).toHaveAttribute('aria-expanded', 'true');
  await svall.api.call('char.close', { id: c.id });
});

test('a kind says whether it is attached or looked up, and the breadcrumb leads with the tier', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await expect(page.getByTestId('resources-kind-badge-instructions')).toHaveText('attached');
  await expect(page.getByTestId('resources-kind-badge-skills')).toHaveText('lookup');
  await expect(page.getByTestId('resources-kind-badge-hooks')).toHaveCount(0);
  await page.getByTestId('resources-what-skills').click();
  await page.getByTestId('resources-item-skills-ship-it').click();
  await expect(page.getByTestId('resources-editor-crumb')).toHaveText(/Global\s*\/\s*Claude\s*\/\s*Skills\s*\/\s*SKILL\.md/);
  await expect(page.getByTestId('resources-editor-path')).toContainText('skills/ship-it/SKILL.md');
});

const listWidth = async (page: Page): Promise<number> => (await page.getByTestId('resources-list').boundingBox())!.width;

async function dragList(page: Page, dx: number): Promise<void> {
  const grip = (await page.getByTestId('resources-split-list').boundingBox())!;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(grip.x + grip.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + dx, y, { steps: 4 });
  await page.mouse.up();
}

test('the list column is dragged wider and comes back that wide', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId('resources-pill').click();
  const before = await listWidth(page);
  await dragList(page, 80);
  await expect.poll(() => listWidth(page)).toBeCloseTo(before + 80, -1);

  await svall.open('map');
  await page.getByTestId('resources-pill').click();
  await expect.poll(() => listWidth(page)).toBeCloseTo(before + 80, -1);
});

test('a drag on a narrow map starts from the width on screen', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId('resources-pill').click();
  // the stored width is pushed past anything a narrow map will render
  await dragList(page, 600);
  // narrow, but with room above the list's least width for the drag back
  await page.setViewportSize({ width: 1300, height: 1000 });
  const capped = await listWidth(page);
  expect(capped).toBeLessThan(RESOURCE_COL_RANGE.list.max);
  await dragList(page, -60);
  await expect.poll(() => listWidth(page)).toBeCloseTo(capped - 60, -1);
});

test('the shelf is dragged smaller from its corner, opens at that size again, and the size button fills its room', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId('resources-pill').click();
  const shelf = page.getByTestId('resources-shelf');
  const before = (await shelf.boundingBox())!;
  const grip = (await page.getByTestId('resources-grip').boundingBox())!;
  const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 120, from.y - 80, { steps: 8 });
  await page.mouse.up();
  // the shelf stays centred, so each edge moves half as far as the grip
  await expect.poll(async () => (await shelf.boundingBox())!.width).toBeCloseTo(before.width - 240, 0);
  const small = (await shelf.boundingBox())!;
  expect(small.height).toBeCloseTo(before.height - 160, 0);
  expect(small.x - before.x).toBeCloseTo(120, 0);
  expect(small.y - before.y).toBeCloseTo(80, 0);

  await svall.open('map');
  await page.getByTestId('resources-pill').click();
  await expect.poll(async () => (await shelf.boundingBox())!.width).toBeCloseTo(small.width, 0);

  await page.getByTestId('resources-size').click();
  await expect(shelf).toHaveAttribute('data-full', 'true');
  await expect(page.getByTestId('resources-grip')).toHaveCount(0);
  // full, the shelf fills the room the default leaves a twentieth around, and comes down to the row
  await expect.poll(async () => (await shelf.boundingBox())!.width).toBeCloseTo(before.width / 0.9, 0);
  const row = (await page.getByTestId('home-row').boundingBox())!;
  const full = (await shelf.boundingBox())!;
  expect(row.y - (full.y + full.height)).toBeLessThan(40);
  await rowClearOfShelf(page);
  await page.getByTestId('resources-size').click();
  await expect.poll(async () => (await shelf.boundingBox())!.width).toBeCloseTo(small.width, 0);
});

test('a hook opens settings.json with the cursor on its event, and Esc closes the shelf', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-what-hooks').click();
  await page.getByTestId('resources-item-hooks-Stop').click();
  await expect(page.getByTestId('resources-editor-path')).toContainText('settings.json');
  // both hooks live in settings.json; only the one pressed is chosen
  await expect(page.getByTestId('resources-item-hooks-Stop')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('resources-item-hooks-PreToolUse')).toHaveAttribute('data-active', 'false');
  await expect(page.locator('.cm-activeLine')).toContainText('"Stop"');
  await page.keyboard.type('X');
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('X"Stop"');
  await page.getByTestId('resources-filter').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('resources-shelf')).toHaveCount(0);
});

test('the side card’s button opens the shelf on that character’s repository', async ({ page, svall }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-res-'));
  fs.mkdirSync(path.join(dir, '.claude/skills/prepush'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/skills/prepush/SKILL.md'), '---\nname: prepush\ndescription: Before pushing\n---\n');
  const island = await svall.api.call('island.create', { name: svall.uniq('res') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: dir, name: 'pusher' });
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId(`token-${c.id}`).click();
  await page.getByTestId('side-resources').click();
  const { sources } = await svall.api.call('resources.get', {});
  const mine = sources.find((s) => s.characterIds.includes(c.id))!;
  await expect(page.getByTestId(`resources-where-${mine.rootId}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('resources-item-skills-prepush')).toBeVisible();

  // the button's press goes through the shelf's click-away like the islet's and the pill's do: no close/reopen
  await page.evaluate(() => document.querySelector('[data-testid="resources-shelf"]')?.setAttribute('data-mark', '1'));
  await page.getByTestId('side-resources').click();
  await expect(page.getByTestId(`resources-where-${mine.rootId}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('resources-shelf')).toHaveAttribute('data-mark', '1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a repository skill and agent are deleted from their rows, and Undo puts the skill back whole', async ({ page, svall }) => {
  // the shell reports its folder by its real path, and a root that changes spelling moves the shelf off it
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'svall-res-')));
  const skill = path.join(dir, '.claude/skills/prepush');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: prepush\ndescription: Before pushing\n---\n');
  fs.writeFileSync(path.join(skill, 'check.sh'), 'exit 0\n');
  fs.mkdirSync(path.join(dir, '.claude/agents'));
  fs.writeFileSync(path.join(dir, '.claude/agents/critic.md'), '---\nname: critic\n---\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# repo\n');
  const island = await svall.api.call('island.create', { name: svall.uniq('del') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: dir, name: 'deleter' });
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId(`token-${c.id}`).click();
  await page.getByTestId('side-resources').click();

  await page.getByTestId('resources-item-instructions-CLAUDE.md').hover();
  await expect(page.getByTestId('resources-delete-instructions-CLAUDE.md')).toHaveCount(0);
  await page.getByTestId('resources-item-skills-prepush').hover();
  await page.getByTestId('resources-delete-skills-prepush').click();
  await expect(page.getByTestId('resources-item-skills-prepush')).toHaveCount(0);
  expect(fs.existsSync(skill)).toBe(false);
  await page.getByTestId('toast-action').click();
  await expect(page.getByTestId('resources-item-skills-prepush')).toBeVisible();
  expect(fs.readdirSync(skill).sort()).toEqual(['SKILL.md', 'check.sh']);

  await page.getByTestId('resources-item-agents-critic').hover();
  await page.getByTestId('resources-delete-agents-critic').click();
  await expect(page.getByTestId('resources-item-agents-critic')).toHaveCount(0);
  expect(fs.readdirSync(path.join(dir, '.claude/agents'))).toEqual([]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the shelf stands over an open terminal card', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('under') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'under' });
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId(`sb-char-${c.id}`).dblclick();
  const card = page.getByTestId('terminal-card');
  await expect(card).toHaveAttribute('data-char', c.id);
  await page.getByTestId('resources-pill').click();
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  const box = (await card.boundingBox())!;
  const top = await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="resources-shelf"]')), [box.x + box.width / 2, box.y + box.height / 2]);
  expect(top).toBe(true);
});

test('a double-click on the islet or the shelf makes no island', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  const count = async () => Object.keys((await svall.api.call('state.get', {})).islands).length;
  const before = await count();
  const land = (await page.getByTestId('resources-islet').boundingBox())!;
  await page.mouse.dblclick(land.x + land.width / 2, land.y + land.height / 2);
  await page.getByTestId('resources-lighthouse').dblclick();
  await page.getByTestId('resources-pill').click();
  await page.getByTestId('resources-what-skills').dblclick();
  await expect(page.getByTestId('resources-what-skills')).toHaveAttribute('aria-pressed', 'true');
  expect(await count()).toBe(before);
});

test('a doc is made, renamed, deleted and brought back from the shelf', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  const island = await svall.api.call('island.create', { name: svall.uniq('isle') });
  const dir = path.join(svall.home, 'docs', 'islands', island.id);
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-caret-island').click();
  await page.getByTestId(`resources-where-r:${dir}`).click();
  await page.getByTestId('resources-what-docs').click();

  await page.getByTestId('resources-new-doc').click();
  // a click elsewhere leaves the field standing
  await page.getByTestId('resources-filter').click();
  await expect(page.getByTestId('resources-new-doc-name')).toBeVisible();
  await page.getByTestId('resources-new-doc-name').fill('Native Surfaces');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('resources-item-docs-native-surfaces')).toBeVisible();
  await expect(page.getByTestId('resources-editor-crumb')).toContainText('native-surfaces.md');
  // the description field takes the keys, and the text shows only the body
  await expect(page.getByTestId('resources-doc-description')).toBeFocused();
  await expect(page.locator('.res-editor .cm-content')).not.toContainText('description:');
  await page.keyboard.type('Overlays hide native surfaces.');
  await page.keyboard.press('Enter');
  await editorHasKeys(page);
  await page.keyboard.type('# Native surfaces');
  // it saves itself, and the row reads the new description
  await expect.poll(() => fs.readFileSync(path.join(dir, 'native-surfaces.md'), 'utf8'))
    .toBe('---\ndescription: Overlays hide native surfaces.\n---\n# Native surfaces\n');
  await expect(page.getByTestId('resources-save-state')).toHaveText('saved');
  await expect(page.getByTestId('resources-item-docs-native-surfaces')).toContainText('Overlays hide native surfaces.');
  // the text takes the keys back after a look at the preview
  await page.locator('.res-editor').getByRole('button', { name: 'Preview' }).click();
  await page.locator('.res-editor').getByRole('button', { name: 'Text' }).click();
  await editorHasKeys(page);

  // the same name again is refused where the user can see it, and the typed name stays for another try
  await page.getByTestId('resources-new-doc').click();
  await page.getByTestId('resources-new-doc-name').fill('native surfaces');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toast')).toContainText('already there');
  await expect(page.getByTestId('resources-new-doc-name')).toHaveValue('native surfaces');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('resources-new-doc-name')).toHaveCount(0);

  // the row's controls come out under the pointer
  await page.getByTestId('resources-item-docs-native-surfaces').hover();
  await page.getByTestId('resources-doc-rename-native-surfaces').click();
  await page.getByTestId('resources-doc-rename-name').fill('surfaces');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('resources-item-docs-surfaces')).toBeVisible();
  await expect(page.getByTestId('resources-editor-crumb')).toContainText('surfaces.md');
  expect(fs.readdirSync(dir)).toEqual(['surfaces.md']);

  const text = fs.readFileSync(path.join(dir, 'surfaces.md'), 'utf8');
  await page.getByTestId('resources-item-docs-surfaces').hover();
  await page.getByTestId('resources-doc-delete-surfaces').click();
  await expect.poll(() => fs.readdirSync(dir)).toEqual([]);
  await page.getByTestId('toast-action').click();
  await expect.poll(() => fs.existsSync(path.join(dir, 'surfaces.md')) && fs.readFileSync(path.join(dir, 'surfaces.md'), 'utf8')).toBe(text);

  // let go, a delete stays done: an undo stands longer than a plain toast, then goes
  await page.getByTestId('resources-item-docs-surfaces').hover();
  await page.getByTestId('resources-doc-delete-surfaces').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 12_000 });
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('closing the shelf keeps what was typed in a doc, and drops a new doc left blank', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  const island = await svall.api.call('island.create', { name: svall.uniq('isle') });
  const dir = path.join(svall.home, 'docs', 'islands', island.id);
  const sameKey: string[] = [];
  page.on('console', (m) => { if (m.text().includes('two children with the same key')) sameKey.push(m.text()); });
  await page.clock.install();
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-caret-island').click();
  await page.getByTestId(`resources-where-r:${dir}`).click();
  await page.getByTestId('resources-what-docs').click();

  await page.getByTestId('resources-new-doc').click();
  await page.getByTestId('resources-new-doc-name').fill('kept');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('resources-doc-description')).toBeFocused();
  // the page's clock stands still, so autosave never fires and only the close can write the edits
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.keyboard.type('Read me.');
  await page.keyboard.press('Enter');
  await editorHasKeys(page);
  await page.keyboard.type('# Kept');
  await page.getByTestId('resources-close').click();
  await expect.poll(() => fs.readFileSync(path.join(dir, 'kept.md'), 'utf8')).toBe('---\ndescription: Read me.\n---\n# Kept\n');
  await page.clock.resume();

  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId(`resources-where-r:${dir}`).click();
  await page.getByTestId('resources-what-docs').click();
  await expect(page.getByTestId('resources-item-docs-kept')).toContainText('Read me.');
  await page.getByTestId('resources-new-doc').click();
  await page.getByTestId('resources-new-doc-name').fill('blank');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('resources-doc-description')).toBeFocused();
  await page.getByTestId('resources-close').click();
  await expect(page.getByTestId('toast')).toContainText('Discarded empty blank');
  expect(fs.existsSync(path.join(dir, 'blank.md'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'kept.md'))).toBe(true);
  expect(sameKey).toEqual([]);
});

test('a doc waiting to be saved is written as the window hides', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  const island = await svall.api.call('island.create', { name: svall.uniq('isle') });
  const dir = path.join(svall.home, 'docs', 'islands', island.id);
  await page.clock.install();
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-caret-island').click();
  await page.getByTestId(`resources-where-r:${dir}`).click();
  await page.getByTestId('resources-what-docs').click();
  await page.getByTestId('resources-new-doc').click();
  await page.getByTestId('resources-new-doc-name').fill('hidden');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('resources-doc-description')).toBeFocused();

  // the page's clock stands still, so only the hide can write the edit
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.keyboard.type('Saved as it hides.');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => fs.readFileSync(path.join(dir, 'hidden.md'), 'utf8')).toContain('description: Saved as it hides.');
});

test('keys at the top of a doc leave its frontmatter whole, and a doc changed on disk is not saved over', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  const island = await svall.api.call('island.create', { name: svall.uniq('isle') });
  const dir = path.join(svall.home, 'docs', 'islands', island.id);
  const file = path.join(dir, 'plan.md');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '---\ndescription: The plan\n---\n# Plan\n');
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-caret-island').click();
  await page.getByTestId(`resources-where-r:${dir}`).click();
  await page.getByTestId('resources-what-docs').click();
  await page.getByTestId('resources-item-docs-plan').click();
  await page.locator('.res-editor .cm-content').click();
  await editorHasKeys(page);

  // the top of the text is the start of the body, and nothing reaches back into the block
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('Top. ');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('>');
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('---\ndescription: The plan\n---\n>Top. # Plan\n');
  await expect(page.getByTestId('resources-save-state')).toHaveText('saved');

  // an agent rewrites it while it stands open: the next edit is not written over it, and the footer says so
  fs.writeFileSync(file, '---\ndescription: Theirs\n---\n# Their plan\n');
  await page.keyboard.type('more');
  await expect(page.getByTestId('conflict-banner')).toBeVisible();
  await expect(page.getByTestId('resources-save-state')).toHaveText('not saved');
  expect(fs.readFileSync(file, 'utf8')).toBe('---\ndescription: Theirs\n---\n# Their plan\n');
});

test('a doc whose write fails says not saved, and ⌘S writes it once the disk takes it', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  const island = await svall.api.call('island.create', { name: svall.uniq('isle') });
  const dir = path.join(svall.home, 'docs', 'islands', island.id);
  const file = path.join(dir, 'plan.md');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '---\ndescription: The plan\n---\n# Plan\n');
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-caret-island').click();
  await page.getByTestId(`resources-where-r:${dir}`).click();
  await page.getByTestId('resources-what-docs').click();
  await page.getByTestId('resources-item-docs-plan').click();
  await page.locator('.res-editor .cm-content').click();
  await editorHasKeys(page);

  fs.chmodSync(file, 0o444);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('More.');
  await expect(page.getByTestId('toast')).toContainText('Save failed');
  await expect(page.getByTestId('resources-save-state')).toHaveText('not saved');

  fs.chmodSync(file, 0o644);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByTestId('resources-save-state')).toHaveText('saved');
  expect(fs.readFileSync(file, 'utf8')).toBe('---\ndescription: The plan\n---\n# Plan\nMore.');
});

test('a relative Markdown link opens another resource doc', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  const island = await svall.api.call('island.create', { name: svall.uniq('linked-docs') });
  const dir = path.join(svall.home, 'docs', 'islands', island.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'source.md'), '# Source\n\n[Target](./target.md)\n');
  fs.writeFileSync(path.join(dir, 'target.md'), '# Target\n');

  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-caret-island').click();
  await page.getByTestId(`resources-where-r:${dir}`).click();
  await page.getByTestId('resources-what-docs').click();
  await page.getByTestId('resources-item-docs-source').click();
  const editor = page.getByTestId('editor');
  await editor.getByRole('button', { name: 'Preview' }).click();
  await editor.getByTestId('markdown-preview').getByRole('link', { name: 'Target' }).click();
  await expect(page.getByTestId('resources-editor-crumb')).toContainText('target.md');
});

test('the chord opens the shelf on the board and lands on the map', async ({ page, svall }) => {
  await svall.open('board');
  await page.keyboard.press('Meta+Shift+r');
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  await page.keyboard.press('Meta+Shift+r');
  await expect(page.getByTestId('resources-shelf')).toHaveCount(0);
});

// the map calls preventDefault on its presses, so the browser sends no mousedown after them
test('a press on the map closes the shelf', async ({ page, svall }) => {
  await svall.open('map');
  await page.keyboard.press('Meta+Shift+r');
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  // open water, left of the shelf and below it
  await page.getByTestId('map').click({ position: { x: 12, y: 580 } });
  await expect(page.getByTestId('resources-shelf')).toHaveCount(0);
});

test('an island’s note, agent instructions and links stand among its resources', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  const island = await svall.api.call('island.create', {
    name: svall.uniq('isle'), description: 'The repo and both worktrees.',
    context: [{ kind: 'other', ref: 'https://example.test/board', label: '', source: 'manual', pinned: true }],
  });
  const dir = path.join(svall.home, 'docs', 'islands', island.id);
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-caret-island').click();
  await page.getByTestId(`resources-where-r:${dir}`).click();

  await expect(page.getByTestId('resources-item-note-Description')).toContainText('The repo and both worktrees.');
  await expect(page.getByTestId('resources-kind-badge-agentInstructions')).toHaveText('attached');
  await expect(page.getByTestId('resources-item-links-example.test/board')).toBeVisible();

  await page.getByTestId('resources-what-agentInstructions').click();
  await expect(page.getByTestId('resources-editor-crumb')).toHaveText(/Island\s*\/\s*.+\s*\/\s*Instructions/);
  await page.getByTestId('resources-field').fill('Run the by-eye pass before merging.');
  await page.getByTestId('resources-filter').click();
  await expect.poll(async () => (await svall.api.call('state.get', {})).islands[island.id].instructions).toBe('Run the by-eye pass before merging.');
  await expect(page.getByTestId('resources-item-agentInstructions-Instructions')).toContainText('Run the by-eye pass before merging.');

  // only an island and a character have a card; nothing else is offered its kinds
  await page.getByTestId(`resources-where-r:${path.join(svall.home, 'claude')}`).click();
  await expect(page.getByTestId('resources-what-note')).toHaveCount(0);
});

test('the arrow keys walk the tree as folders, and the list on into the editor', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.className ?? '');
  const claude = `r:${path.join(svall.home, 'claude')}`;

  // down the tree: the Global folder is picked and lists its sources, then the source under it is picked
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('resources-group-global');
  await expect(page.getByTestId('resources-group-global')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId(`resources-list-source-${claude}`)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId(`resources-where-${claude}`)).toHaveAttribute('aria-pressed', 'true');

  // a shut folder opens under right and shuts under left; only an open one lets right go on to the list
  await page.getByTestId('resources-group-character').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('resources-group-character')).toHaveAttribute('aria-expanded', 'true');
  expect(await focused()).toBe('resources-group-character');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('resources-group-character')).toHaveAttribute('aria-expanded', 'false');

  // right from a source into the list, which keeps its pick; down picks the next row, up the row before it
  await page.getByTestId(`resources-where-${claude}`).focus();
  await page.keyboard.press('ArrowRight');
  expect(await focused()).toBe('resources-item-instructions-CLAUDE.md');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('resources-item-skills-ship-it');
  await expect(page.getByTestId('resources-editor-path')).toContainText('skills/ship-it/SKILL.md');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('resources-editor-path')).toContainText('CLAUDE.md');
  // the pane only shows what the list chose, so the keys stay on the row until they are sent to the editor
  expect(await focused()).toBe('resources-item-instructions-CLAUDE.md');
  await page.keyboard.press('ArrowRight');
  expect(await focused()).toContain('cm-content');

  // left from the list lands on the tree's pick, and left again climbs to the tier it stands under
  await page.getByTestId('resources-item-instructions-CLAUDE.md').focus();
  await page.keyboard.press('ArrowLeft');
  expect(await focused()).toBe(`resources-where-${claude}`);
  await page.keyboard.press('ArrowLeft');
  expect(await focused()).toBe('resources-group-global');
  await expect(page.getByTestId('resources-group-global')).toHaveAttribute('aria-pressed', 'true');
});

test('walking the list picks each row it passes, and leaves a link alone', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  const island = await svall.api.call('island.create', {
    name: svall.uniq('isle'), description: 'The repo and both worktrees.',
    context: [{ kind: 'other', ref: 'https://example.test/board', label: '', source: 'manual', pinned: true }],
  });
  const dir = path.join(svall.home, 'docs', 'islands', island.id);
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-caret-island').click();
  await page.getByTestId(`resources-where-r:${dir}`).click();
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.className ?? '');

  // down from the note to the instructions: the row the keys reach is the row the pane shows
  await page.getByTestId('resources-item-note-Description').focus();
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('resources-item-agentInstructions-Instructions');
  await expect(page.getByTestId('resources-editor-crumb')).toHaveText(/Island\s*\/\s*.+\s*\/\s*Instructions/);

  // a link row takes the keys without being followed: no tab is opened and the pane keeps the field
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('resources-item-links-example.test/board');
  expect(page.context().pages()).toHaveLength(1);
  await expect(page.getByTestId('resources-editor-crumb')).toHaveText(/Island\s*\/\s*.+\s*\/\s*Instructions/);
});

test('the fleet’s own docs stand in a tier of their own, named for the fleet, and a note is written there', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  const dir = path.join(svall.home, 'docs', 'fleet');
  await svall.open('map');
  await page.getByTestId('resources-lighthouse').click();
  // Fleet stands open under Global, its one row named for this fleet and held to this window
  await expect(page.getByTestId('resources-group-fleet')).toHaveAttribute('aria-expanded', 'true');
  const row = page.getByTestId(`resources-where-r:${dir}`);
  await expect(row).toContainText(path.basename(svall.home));
  await expect(row).toHaveAttribute('title', /this window only/);
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('resources-chain')).toHaveCount(0);

  // nothing owns the fleet's folder, so it outlives the islands a spec clears away: each run writes its own note
  const name = svall.uniq('how-we-write');
  await page.getByTestId('resources-what-docs').click();
  await page.getByTestId('resources-new-doc').click();
  await page.getByTestId('resources-new-doc-name').fill(name);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`resources-item-docs-${name}`)).toBeVisible();
  await expect(page.getByTestId('resources-doc-description')).toBeFocused();
  await page.keyboard.type('Plain words, no filler.');
  await expect.poll(() => fs.readFileSync(path.join(dir, `${name}.md`), 'utf8')).toContain('description: Plain words, no filler.');
});

test('a new agent profile is written in the fleet’s shelf and offered to every character', async ({ page, svall }) => {
  await page.setViewportSize(WIDE);
  const file = path.join(svall.home, 'agent-profiles', 'critic.md');
  fs.rmSync(file, { force: true });
  const island = await svall.api.call('island.create', { name: svall.uniq('critic') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'critiqued' });
  await svall.open();
  await page.getByTestId(`sb-char-${c.id}`).click();
  const pick = page.getByTestId('side-card').getByTestId('side-agent-profile');
  await pick.click();
  await page.getByTestId('side-agent-profile-opt-manage').click();
  await expect(page.getByTestId('resources-what-agentProfiles')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('resources-item-agentProfiles-reviewer')).toBeVisible();

  await expect(page.getByTestId('resources-new-doc')).toHaveText('+ new profile');
  await page.getByTestId('resources-new-doc').click();
  await page.getByTestId('resources-new-doc-name').fill('Critic');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('resources-editor-crumb')).toContainText('critic.md');
  await expect(page.getByText('What is this role for?')).toBeVisible();
  await expect(page.getByTestId('resources-doc-description')).toBeFocused();
  await page.keyboard.type('Argues against the plan.');
  await page.keyboard.press('Enter');
  await editorHasKeys(page);
  await page.keyboard.type('You argue against every plan you are shown.');
  await expect.poll(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8'))
    .toBe('---\ndescription: Argues against the plan.\n---\nYou argue against every plan you are shown.\n');

  await page.getByTestId('resources-close').click();
  await pick.click();
  await page.getByTestId('side-agent-profile-opt-critic').click();
  await expect(page.getByTestId('side-agent-profile-hint')).toHaveText('Argues against the plan.');
  await expect.poll(async () => (await svall.api.call('char.show', { id: c.id })).text)
    .toContain('Agent profile: critic — follow this role.\nYou argue against every plan you are shown.');

  // written past the cap, it stops reaching the agent, and the card says so without a reload
  await page.getByTestId('side-agent-profile-view').click();
  await page.locator('.res-editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(` ${'x'.repeat(1600)}`);
  await expect(page.getByTestId('side-agent-profile-hint')).toHaveText('critic is over 1500 characters');
  expect((await svall.api.call('char.show', { id: c.id })).text).not.toContain('Agent profile');
  fs.rmSync(file, { force: true });
});
