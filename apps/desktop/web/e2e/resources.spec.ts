import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { RESOURCE_COL_RANGE } from '../src/store/index.js';
import { expect, test } from './fixtures.js';

// home and the islet fit as a centred pair from 1064px of map; this leaves 1841px past the sidebar
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

test('the islet stands right of mission control and the lighthouse on it opens the shelf on all resources', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  await archi.open('map');
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

test('a narrow map keeps the islet, drawn smaller and clear of the edge', async ({ page, archi }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await archi.open('map');
  const islet = () => page.getByTestId('resources-islet').boundingBox().then((b) => b!.width);
  const towerRight = () => page.getByTestId('resources-lighthouse').boundingBox().then((b) => b!.x + b!.width);
  await expect.poll(towerRight).toBeLessThanOrEqual(900);
  const wide = await islet();

  await page.setViewportSize({ width: 620, height: 800 });
  await expect.poll(islet).toBeLessThan(wide);
  await expect.poll(towerRight).toBeLessThanOrEqual(620);
  await expect(page.getByTestId('resources-lighthouse').boundingBox().then((b) => b!.x)).resolves.toBeGreaterThanOrEqual(0);

  await page.getByTestId('resources-lighthouse').click();
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  await rowClearOfShelf(page);
});

test('a folded mission control leaves only the pill, at the end of its row', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  await archi.open('map');
  await page.getByTestId('home-toggle').click();
  await expect(page.getByTestId('resources-islet')).toHaveCount(0);
  await page.getByTestId('home-row').getByTestId('resources-pill').click();
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  await rowClearOfShelf(page);
  // the fold is the fleet's, so it is put back for whatever runs next
  await page.getByTestId('home-toggle').click();
  await expect(page.getByTestId('resources-islet')).toBeVisible();
});

test('a skill opens in the editor, is edited, and is saved to the run’s Claude dir', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  await archi.open('map');
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
  await expect.poll(() => fs.readFileSync(path.join(archi.home, 'claude/skills/ship-it/SKILL.md'), 'utf8')).toContain('Never on a Friday.');
});

test('a kind with one file shows it with no row to press', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  await archi.open('map');
  await page.getByTestId('resources-lighthouse').click();
  await page.getByTestId('resources-what-instructions').click();
  await expect(page.getByTestId('resources-editor-path')).toContainText('CLAUDE.md');
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('# e2e');
});

test('the tree folds a tier a folder, lists its sources when picked, and a character’s chain leads to its island', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  const island = await archi.api.call('island.create', { name: archi.uniq('isle') });
  const c = await archi.api.call('char.create', { islandId: island.id, cwd: os.tmpdir() });
  await archi.open('map');
  await page.getByTestId('resources-lighthouse').click();

  // Global stands open by default; the other three are one row each
  await expect(page.getByTestId('resources-group-global')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('resources-group-character')).toHaveAttribute('aria-expanded', 'false');

  // a press on the folder picks the tier, and the list is its sources; the caret opens it
  const docs = path.join(archi.home, 'docs');
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
  await archi.api.call('char.close', { id: c.id });
});

test('a kind says whether it is attached or looked up, and the breadcrumb leads with the tier', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  await archi.open('map');
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

test('the list column is dragged wider and comes back that wide', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  await archi.open('map');
  await page.getByTestId('resources-pill').click();
  const before = await listWidth(page);
  await dragList(page, 80);
  await expect.poll(() => listWidth(page)).toBeCloseTo(before + 80, -1);

  await archi.open('map');
  await page.getByTestId('resources-pill').click();
  await expect.poll(() => listWidth(page)).toBeCloseTo(before + 80, -1);
});

test('a drag on a narrow map starts from the width on screen', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  await archi.open('map');
  await page.getByTestId('resources-pill').click();
  // the stored width is pushed past anything a narrow map will render
  await dragList(page, 600);
  await page.setViewportSize({ width: 1100, height: 1000 });
  const capped = await listWidth(page);
  expect(capped).toBeLessThan(RESOURCE_COL_RANGE.list.max);
  await dragList(page, -60);
  await expect.poll(() => listWidth(page)).toBeCloseTo(capped - 60, -1);
});

test('a hook opens settings.json with the cursor on its event, and Esc closes the shelf', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  await archi.open('map');
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

test('the side card’s button opens the shelf on that character’s repository', async ({ page, archi }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archi-res-'));
  fs.mkdirSync(path.join(dir, '.claude/skills/prepush'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/skills/prepush/SKILL.md'), '---\nname: prepush\ndescription: Before pushing\n---\n');
  const island = await archi.api.call('island.create', { name: archi.uniq('res') });
  const c = await archi.api.call('char.create', { islandId: island.id, cwd: dir, name: 'pusher' });
  await page.setViewportSize(WIDE);
  await archi.open('map');
  await page.getByTestId(`token-${c.id}`).click();
  await page.getByTestId('side-resources').click();
  const { sources } = await archi.api.call('resources.get', {});
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

test('the shelf stands over an open terminal card', async ({ page, archi }) => {
  const island = await archi.api.call('island.create', { name: archi.uniq('under') });
  const c = await archi.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'under' });
  await page.setViewportSize(WIDE);
  await archi.open('map');
  await page.getByTestId(`sb-char-${c.id}`).dblclick();
  const card = page.getByTestId('terminal-card');
  await expect(card).toHaveAttribute('data-char', c.id);
  await page.getByTestId('resources-pill').click();
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  const box = (await card.boundingBox())!;
  const top = await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="resources-shelf"]')), [box.x + box.width / 2, box.y + box.height / 2]);
  expect(top).toBe(true);
});

test('a double-click on the islet or the shelf makes no island', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  await archi.open('map');
  const count = async () => Object.keys((await archi.api.call('state.get', {})).islands).length;
  const before = await count();
  const land = (await page.getByTestId('resources-islet').boundingBox())!;
  await page.mouse.dblclick(land.x + land.width / 2, land.y + land.height / 2);
  await page.getByTestId('resources-lighthouse').dblclick();
  await page.getByTestId('resources-pill').click();
  await page.getByTestId('resources-what-skills').dblclick();
  await expect(page.getByTestId('resources-what-skills')).toHaveAttribute('aria-pressed', 'true');
  expect(await count()).toBe(before);
});

test('a doc is made, renamed, deleted and brought back from the shelf', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  const island = await archi.api.call('island.create', { name: archi.uniq('isle') });
  const dir = path.join(archi.home, 'docs', 'islands', island.id);
  await archi.open('map');
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

test('closing the shelf keeps what was typed in a doc, and drops a new doc left blank', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  const island = await archi.api.call('island.create', { name: archi.uniq('isle') });
  const dir = path.join(archi.home, 'docs', 'islands', island.id);
  const sameKey: string[] = [];
  page.on('console', (m) => { if (m.text().includes('two children with the same key')) sameKey.push(m.text()); });
  await page.clock.install();
  await archi.open('map');
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

test('a doc waiting to be saved is written as the window hides', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  const island = await archi.api.call('island.create', { name: archi.uniq('isle') });
  const dir = path.join(archi.home, 'docs', 'islands', island.id);
  await page.clock.install();
  await archi.open('map');
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

test('keys at the top of a doc leave its frontmatter whole, and a doc changed on disk is not saved over', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  const island = await archi.api.call('island.create', { name: archi.uniq('isle') });
  const dir = path.join(archi.home, 'docs', 'islands', island.id);
  const file = path.join(dir, 'plan.md');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '---\ndescription: The plan\n---\n# Plan\n');
  await archi.open('map');
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

test('a doc whose write fails says not saved, and ⌘S writes it once the disk takes it', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  const island = await archi.api.call('island.create', { name: archi.uniq('isle') });
  const dir = path.join(archi.home, 'docs', 'islands', island.id);
  const file = path.join(dir, 'plan.md');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '---\ndescription: The plan\n---\n# Plan\n');
  await archi.open('map');
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

test('a relative Markdown link opens another resource doc', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  const island = await archi.api.call('island.create', { name: archi.uniq('linked-docs') });
  const dir = path.join(archi.home, 'docs', 'islands', island.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'source.md'), '# Source\n\n[Target](./target.md)\n');
  fs.writeFileSync(path.join(dir, 'target.md'), '# Target\n');

  await archi.open('map');
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

test('the chord opens the shelf on the board and lands on the map', async ({ page, archi }) => {
  await archi.open('board');
  await page.keyboard.press('Meta+Shift+r');
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  await page.keyboard.press('Meta+Shift+r');
  await expect(page.getByTestId('resources-shelf')).toHaveCount(0);
});

// the map calls preventDefault on its presses, so the browser sends no mousedown after them
test('a press on the map closes the shelf', async ({ page, archi }) => {
  await archi.open('map');
  await page.keyboard.press('Meta+Shift+r');
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  // open water, left of the shelf and below it
  await page.getByTestId('map').click({ position: { x: 12, y: 580 } });
  await expect(page.getByTestId('resources-shelf')).toHaveCount(0);
});

test('an island’s note, agent instructions and links stand among its resources', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  const island = await archi.api.call('island.create', {
    name: archi.uniq('isle'), description: 'The repo and both worktrees.',
    context: [{ kind: 'other', ref: 'https://example.test/board', label: '', source: 'manual', pinned: true }],
  });
  const dir = path.join(archi.home, 'docs', 'islands', island.id);
  await archi.open('map');
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
  await expect.poll(async () => (await archi.api.call('state.get', {})).islands[island.id].instructions).toBe('Run the by-eye pass before merging.');
  await expect(page.getByTestId('resources-item-agentInstructions-Instructions')).toContainText('Run the by-eye pass before merging.');

  // only an island and a character have a card; nothing else is offered its kinds
  await page.getByTestId(`resources-where-r:${path.join(archi.home, 'claude')}`).click();
  await expect(page.getByTestId('resources-what-note')).toHaveCount(0);
});

test('the arrow keys walk the tree as folders, and the list on into the editor', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  await archi.open('map');
  await page.getByTestId('resources-lighthouse').click();
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.className ?? '');
  const claude = `r:${path.join(archi.home, 'claude')}`;

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

test('walking the list picks each row it passes, and leaves a link alone', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  const island = await archi.api.call('island.create', {
    name: archi.uniq('isle'), description: 'The repo and both worktrees.',
    context: [{ kind: 'other', ref: 'https://example.test/board', label: '', source: 'manual', pinned: true }],
  });
  const dir = path.join(archi.home, 'docs', 'islands', island.id);
  await archi.open('map');
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

test('the fleet’s own docs stand among the global sources, and a note is written there', async ({ page, archi }) => {
  await page.setViewportSize(WIDE);
  const dir = path.join(archi.home, 'docs', 'fleet');
  await archi.open('map');
  await page.getByTestId('resources-lighthouse').click();
  // Global stands open, so the fleet's row is there beside Claude's
  await expect(page.getByTestId('resources-group-global')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId(`resources-where-r:${dir}`).click();
  await expect(page.getByTestId(`resources-where-r:${dir}`)).toHaveAttribute('aria-pressed', 'true');

  // nothing owns the fleet's folder, so it outlives the islands a spec clears away: each run writes its own note
  const name = archi.uniq('how-we-write');
  await page.getByTestId('resources-what-docs').click();
  await page.getByTestId('resources-new-doc').click();
  await page.getByTestId('resources-new-doc-name').fill(name);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`resources-item-docs-${name}`)).toBeVisible();
  await expect(page.getByTestId('resources-doc-description')).toBeFocused();
  await page.keyboard.type('Plain words, no filler.');
  await expect.poll(() => fs.readFileSync(path.join(dir, `${name}.md`), 'utf8')).toContain('description: Plain words, no filler.');
});
