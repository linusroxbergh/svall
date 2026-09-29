import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });

// these live outside SVALL_E2E_HOME, so the global teardown never sweeps them
const made: string[] = [];
test.afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

// a repository with one committed file, in a fresh folder the daemon can reach
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-ide-'));
  made.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/hello.ts'), 'export const hello = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test('opens a folder git ignores, a shade back from the rest', async ({ page, svall }) => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'notes/\n');
  fs.mkdirSync(path.join(dir, 'notes'));
  fs.writeFileSync(path.join(dir, 'notes/todo.md'), '# todo\n');
  const island = await svall.api.call('island.create', { name: svall.uniq('ignored') });
  await svall.api.call('char.create', { islandId: island.id, cwd: dir, name: 'reader' });
  await svall.open();
  await page.getByTestId('pane-left-files').click();

  const folder = page.getByTestId('tree-notes');
  await expect(folder).toHaveAttribute('data-ignored', 'true');
  await folder.click();
  await page.getByTestId('tree-notes/todo.md').click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'notes/todo.md');
});

test('the tree folds away and is dragged wider, and comes back that way after a reload', async ({ page, svall }) => {
  const dir = repo();
  const island = await svall.api.call('island.create', { name: svall.uniq('tree') });
  await svall.api.call('char.create', { islandId: island.id, cwd: dir, name: 'reader' });
  await svall.open();
  await page.getByTestId('pane-left-files').click();
  const tree = page.getByTestId('files-tree');
  const width = async () => (await tree.boundingBox())!.width;
  await page.getByTestId('files-tree-hide').click();
  await expect(tree).toHaveCount(0);
  await page.getByTestId('files-tree-show').click();
  await expect(page.getByTestId('tree-src')).toBeVisible();

  // the edge tab sits on the grip's middle, so the drag takes hold above it
  const before = await width();
  const grip = (await page.getByTestId('files-tree-drag').boundingBox())!;
  const x = grip.x + grip.width / 2, y = grip.y + grip.height / 4;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(width).toBeCloseTo(before + 80, -1);
  await page.getByTestId('files-tree-hide').click();

  await svall.open();
  await page.getByTestId('pane-left-files').click();
  await expect(page.getByTestId('files-tree-show')).toBeVisible();
  await expect(tree).toHaveCount(0);
  await page.getByTestId('files-tree-show').click();
  expect(await width()).toBeCloseTo(before + 80, -1);
});

test('Markdown preview shows unsaved edits and returns to the editable text', async ({ page, svall }) => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'README.md'), '# First\n\n- item\n');
  const island = await svall.api.call('island.create', { name: svall.uniq('markdown') });
  await svall.api.call('char.create', { islandId: island.id, cwd: dir, name: 'reader' });
  await svall.open();
  await page.getByTestId('pane-left-files').click();
  await page.getByTestId('tree-README.md').click();
  const editor = page.getByTestId('editor');
  await editor.getByRole('button', { name: 'Preview' }).click();
  await expect(editor.getByTestId('markdown-preview').getByRole('heading', { name: 'First' })).toBeVisible();
  await expect(editor.getByTestId('markdown-preview').getByRole('listitem')).toHaveText('item');
  await editor.getByRole('button', { name: 'Text' }).click();
  await editor.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n## Unsaved');
  await editor.getByRole('button', { name: 'Preview' }).click();
  await expect(editor.getByTestId('markdown-preview').getByRole('heading', { name: 'Unsaved' })).toBeVisible();
  expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).not.toContain('Unsaved');
});

// the page holds the daemon's token, so a document it previews loads images from the app alone
test('Markdown preview shows the app\'s own images and never asks another origin for one', async ({ page, svall }) => {
  let asked = 0;
  const remote = http.createServer((_req, res) => { asked++; res.end(); });
  await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r));
  try {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'README.md'), `![bat](/animals/bat.svg)\n\n![tracker](http://127.0.0.1:${(remote.address() as AddressInfo).port}/pixel.png)\n`);
    const island = await svall.api.call('island.create', { name: svall.uniq('markdown-images') });
    await svall.api.call('char.create', { islandId: island.id, cwd: dir, name: 'reader' });
    await svall.open();
    await page.getByTestId('pane-left-files').click();
    await page.getByTestId('tree-README.md').click();
    const editor = page.getByTestId('editor');
    await editor.getByRole('button', { name: 'Preview' }).click();
    const preview = editor.getByTestId('markdown-preview');
    await expect.poll(() => preview.getByRole('img', { name: 'bat' }).evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    await expect.poll(() => preview.getByRole('img', { name: 'tracker' }).evaluate((i: HTMLImageElement) => i.complete)).toBe(true);
    expect(await preview.getByRole('img', { name: 'tracker' }).evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(0);
    expect(asked).toBe(0);
  } finally {
    await new Promise((r) => remote.close(r));
  }
});

test('Markdown preview follows disk changes and opens local files and sections', async ({ page, svall }) => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'docs'));
  const readme = path.join(dir, 'README.md');
  fs.writeFileSync(readme, '# Old\n');
  fs.writeFileSync(path.join(dir, 'docs/setup.md'), '# Setup\n');
  const island = await svall.api.call('island.create', { name: svall.uniq('markdown-links') });
  await svall.api.call('char.create', { islandId: island.id, cwd: dir, name: 'reader' });
  await svall.open();
  await page.getByTestId('pane-left-files').click();
  await page.getByTestId('tree-README.md').click();
  const editor = page.getByTestId('editor');
  await editor.getByRole('button', { name: 'Preview' }).click();
  await expect(editor.getByTestId('markdown-preview').getByRole('heading', { name: 'Old' })).toBeVisible();
  fs.writeFileSync(readme, '[Prerequisites](#prerequisites)\n\n' + 'Read this section.\n\n'.repeat(60) + '# Prerequisites\n\n[Setup](docs/setup.md)\n');
  const preview = editor.getByTestId('markdown-preview');
  await expect(preview.getByRole('link', { name: 'Prerequisites' })).toBeVisible();
  await preview.getByRole('link', { name: 'Prerequisites' }).click();
  await expect.poll(() => preview.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await preview.getByRole('link', { name: 'Setup' }).click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'docs/setup.md');
});

test('edits a file in the Files tab and sees the change in the Changes tab', async ({ page, svall }) => {
  const dir = repo();
  const island = await svall.api.call('island.create', { name: svall.uniq('ide') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: dir, name: 'coder' });
  await svall.open();
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', c.id);

  // Files: the tree, a folder that opens, a file that opens in the editor
  await page.getByTestId('pane-left-files').click();
  await expect(page.getByTestId('surface')).toHaveCount(0);
  await page.getByTestId('tree-src').click();
  await page.getByTestId('tree-src/hello.ts').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toHaveAttribute('data-path', 'src/hello.ts');
  await expect(editor.locator('.cm-content')).toContainText('export const hello = 1;');

  // typing dirties the tab; Cmd+S writes the file and clears the dot
  await editor.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('export const added = 2;');
  await expect(page.getByTestId('file-tab-src/hello.ts')).toHaveAttribute('data-dirty', 'true');
  await page.keyboard.press('Meta+s');
  await expect(page.getByTestId('file-tab-src/hello.ts')).toHaveAttribute('data-dirty', 'false');
  await expect.poll(() => fs.readFileSync(path.join(dir, 'src/hello.ts'), 'utf8')).toContain('export const added = 2;');

  // Changes: the terminal is gone here too; Cmd+1 brings it back and Cmd+4 returns
  await page.keyboard.press('Meta+4');
  await expect(page.getByTestId('changes')).toBeVisible();
  await expect(page.getByTestId('surface')).toHaveCount(0);
  await page.keyboard.press('Meta+1');
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', c.id);
  await page.keyboard.press('Meta+4');

  // the file is modified against HEAD and the diff shows the new line
  const row = page.getByTestId('change-row');
  await expect(row).toHaveCount(1);
  await expect(row.first()).toHaveAttribute('data-status', 'M');
  await expect(row.first()).toContainText('src/hello.ts');
  await expect(page.getByTestId('diff').locator('.cm-content')).toContainText('export const added = 2;');
  await expect.poll(() => page.getByTestId('diff').locator('.cm-merge-b .cm-changedText').first()
    .evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');

  // an edit on disk reaches the list and the diff without a click
  fs.writeFileSync(path.join(dir, 'src/other.ts'), 'export const other = 3;\n');
  await expect(page.getByTestId('change-row')).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByTestId('change-row').nth(1)).toHaveAttribute('data-status', '?');

  // Open lands in Files on that file; Cmd+1 is the terminal and Cmd+3 comes back to it
  await page.getByTestId('change-row').nth(1).click();
  await page.getByTestId('diff-open').click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'src/other.ts');
  await expect(page.getByTestId('file-tabs')).toContainText('other.ts');
  await page.keyboard.press('Meta+1');
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', c.id);
  await page.keyboard.press('Meta+3');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'src/other.ts');
});

test('a character in a worktree opens Changes against main', async ({ page, svall }) => {
  const dir = repo();
  const tree = path.join(dir, 'side');
  git(dir, 'worktree', 'add', '-q', '-b', 'side', tree);
  fs.writeFileSync(path.join(tree, 'src/hello.ts'), 'export const hello = 2;\n');
  git(tree, 'commit', '-qam', 'side work');
  const island = await svall.api.call('island.create', { name: svall.uniq('branched') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: tree, name: 'brancher' });
  await svall.open();
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', c.id);
  await page.keyboard.press('Meta+4');

  // the branch's own commit is what the character has done, and HEAD alone would show nothing
  await expect(page.getByTestId('base-main')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('change-row')).toHaveCount(1);
  await expect(page.getByTestId('change-row').first()).toContainText('src/hello.ts');
  await page.getByTestId('base-head').click();
  await expect(page.getByTestId('change-row')).toHaveCount(0);
});

test('a dirty buffer meets a changed disk with a banner, and a dirty tab asks before closing', async ({ page, svall }) => {
  const dir = repo();
  const island = await svall.api.call('island.create', { name: svall.uniq('ide') });
  await svall.api.call('char.create', { islandId: island.id, cwd: dir, name: 'coder' });
  await svall.open();
  await page.getByTestId('pane-left-files').click();
  await page.getByTestId('tree-src').click();
  await page.getByTestId('tree-src/hello.ts').click();
  await page.getByTestId('editor').locator('.cm-content').click();
  await page.keyboard.type('// mine\n');
  await expect(page.getByTestId('file-tab-src/hello.ts')).toHaveAttribute('data-dirty', 'true');
  fs.writeFileSync(path.join(dir, 'src/hello.ts'), '// theirs\nexport const hello = 1;\n');
  await expect(page.getByTestId('conflict-banner')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('conflict-reload').click();
  await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('// theirs');
  await expect(page.getByTestId('file-tab-src/hello.ts')).toHaveAttribute('data-dirty', 'false');

  await page.getByTestId('editor').locator('.cm-content').click();
  await page.keyboard.type('// again\n');
  await page.getByTestId('file-close-src/hello.ts').click();
  await expect(page.getByTestId('discard-ask')).toBeVisible();
  await page.getByTestId('discard-no').click();
  await expect(page.getByTestId('file-tab-src/hello.ts')).toHaveCount(1);
  await page.getByTestId('file-close-src/hello.ts').click();
  await page.getByTestId('discard-yes').click();
  await expect(page.getByTestId('file-tab-src/hello.ts')).toHaveCount(0);
  expect(fs.readFileSync(path.join(dir, 'src/hello.ts'), 'utf8')).not.toContain('again');

  // what was discarded is gone: the file opens again with the disk's text
  await page.getByTestId('tree-src/hello.ts').click();
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('// theirs');
  await expect(page.getByTestId('editor').locator('.cm-content')).not.toContainText('again');
  await expect(page.getByTestId('file-tab-src/hello.ts')).toHaveAttribute('data-dirty', 'false');
});

test('the map card carries the same Files and Changes tabs, and the map stays put under them', async ({ page, svall }) => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'src/hello.ts'), 'export const hello = 2;\n');
  const island = await svall.api.call('island.create', { name: svall.uniq('ide-map') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: dir, name: 'coder' });
  await svall.open('map');
  // the sea is what the map last had pressed, which is when a double click on the map makes an island
  const sea = (await page.locator('.map-sea').boundingBox())!;
  await page.mouse.click(sea.x + 8, sea.y + 8);
  await page.getByTestId(`sb-char-${c.id}`).dblclick();
  const card = page.getByTestId('terminal-card');
  await expect(card.getByTestId('surface')).toHaveAttribute('data-char', c.id);

  // Files: the terminal gives way, a file opens in the editor
  await card.getByTestId('pane-left-files').click();
  await expect(card.getByTestId('pane-left-files')).toHaveAttribute('data-active', 'true');
  await expect(card.getByTestId('surface')).toHaveCount(0);
  await card.getByTestId('tree-src').click();
  await card.getByTestId('tree-src/hello.ts').click();
  const text = card.getByTestId('editor').locator('.cm-content');
  await expect(text).toContainText('export const hello = 2;');

  // a wheel over the editor and a double click on a word are the editor's; what the map made of them is read at the end
  const world = page.locator('.map-world');
  const islands = page.locator('svg[data-testid^="island-"]');
  const before = { style: await world.getAttribute('style'), islands: await islands.count() };
  await text.hover();
  await page.mouse.wheel(0, 120);
  await text.dblclick();

  // Changes by key, the browser over it, and the key bringing Changes back
  await page.keyboard.press('Meta+4');
  await expect(card.getByTestId('change-row')).toHaveAttribute('data-status', 'M');
  await expect(card.getByTestId('diff').locator('.cm-content')).toContainText('hello = 2');
  await card.getByTestId('pane-left-browser').click();
  await expect(card.getByTestId('changes')).toHaveCount(0);
  await expect(card.getByTestId('pane-left-changes')).toHaveAttribute('data-active', 'false');
  await page.keyboard.press('Meta+4');
  await expect(card.getByTestId('changes')).toBeVisible();

  // the map neither panned nor grew an island, and an editor bringing its cursor into view did not scroll it
  expect({ style: await world.getAttribute('style'), islands: await islands.count() }).toEqual(before);
  expect(await page.getByTestId('map').evaluate((m) => [m.scrollLeft, m.scrollTop])).toEqual([0, 0]);

  // the board shows the character where the card left it, the map brings it back in its card, and Cmd+1 is the terminal
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('pane-left-changes')).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Meta+m');
  await expect(card.getByTestId('changes')).toBeVisible();
  await page.keyboard.press('Meta+1');
  await expect(card.getByTestId('surface')).toHaveAttribute('data-char', c.id);
});
