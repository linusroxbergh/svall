import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { FAKE_CLAUDE, expect, test } from './fixtures.js';

test('the side card arrows cycle the portrait', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('portrait') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'portrait' });
  await svall.open();
  await page.getByTestId(`sb-char-${c.id}`).click();
  const shown = page.getByTestId('side-card').getByTestId('side-portrait');

  await expect(shown).toHaveAttribute('data-portrait', c.portrait);
  await page.getByTestId('portrait-next').click();
  await expect(shown).not.toHaveAttribute('data-portrait', c.portrait);
  const next = (await shown.getAttribute('data-portrait'))!;
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].portrait).toBe(next);
  await page.getByTestId('portrait-prev').click();
  await expect(shown).toHaveAttribute('data-portrait', c.portrait);
});

test('a note written elsewhere shows in the side card, but not over one being typed', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('follow') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'follow' });
  await svall.open();
  await page.getByTestId(`sb-char-${c.id}`).click();
  const note = page.getByTestId('side-card').getByTestId('side-note');
  // the note is the character's description: as tall as an island's
  await expect(note).toHaveAttribute('rows', '4');
  await svall.api.call('char.update', { id: c.id, note: 'from the fleet' });
  await expect(note).toHaveValue('from the fleet');

  // focused but untouched, the field takes the fleet's value on blur and writes nothing back
  await note.focus();
  await svall.api.call('char.update', { id: c.id, note: 'while focused' });
  await note.blur();
  await expect(note).toHaveValue('while focused');

  await note.fill('typing');
  await svall.api.call('char.update', { id: c.id, note: 'written meanwhile' });
  await expect(note).toHaveValue('typing');
  await note.blur();
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].note).toBe('typing');
});

test('edits a character from the side card', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('side') });
  const other = await svall.api.call('island.create', { name: svall.uniq('side-other') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'edit-me' });
  await svall.open();
  await page.getByTestId(`sb-char-${c.id}`).click();
  // the board opens the side card with the character it shows
  const card = page.getByTestId('side-card');
  await expect(card).toBeVisible();
  await page.getByTestId('board-side').click();
  await expect(card).toBeHidden();
  await page.getByTestId('board-side').click();
  await expect(card).toBeVisible();

  await card.getByTestId('side-name').fill('renamed');
  await card.getByTestId('side-name').press('Enter');
  await expect(page.getByTestId(`sb-char-${c.id}`)).toContainText('renamed');
  await expect(page.getByTestId(`tab-${c.id}`)).toContainText('renamed');
  await card.getByTestId('side-note').fill('what it does');
  await card.getByTestId('side-note').blur();
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].note).toBe('what it does');

  await card.getByTestId('side-instructions').fill('merge without asking');
  await card.getByTestId('side-instructions').blur();
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].instructions).toBe('merge without asking');

  await card.getByTestId('context-ref').fill('https://github.com/o/r/pull/7');
  await card.getByTestId('context-add').click();
  await expect(card.getByTestId('side-context')).toContainText('r #7');
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].context[0]?.kind).toBe('pr');
  await card.getByTestId('context-pin').first().click();
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].context[0]?.pinned).toBe(true);
  await card.getByTestId('context-ref').fill('/tmp');
  await card.getByTestId('context-add').click();
  await expect(card.getByTestId('side-context')).toContainText('tmp');
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].context[1]?.kind).toBe('folder');
  await card.getByTestId('context-remove').first().click();
  await expect(card.getByTestId('side-context')).not.toContainText('r #7');

  await card.getByTestId('side-island').selectOption(other.id);
  await expect(page.getByTestId(`sb-island-${other.id}`)).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId(`sb-folder-${other.id}`).getByTestId(`sb-char-${c.id}`)).toBeVisible();

  // the side card stays open across the views
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(card).toBeVisible();
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(card).toBeVisible();

  await card.getByTestId('side-close').click();
  await page.getByTestId('confirm-close-delete').click();
  await expect(page.getByTestId(`sb-char-${c.id}`)).toHaveCount(0);
  await expect(card).toBeHidden();
});

test('edits an island from the side card on the map', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('iside'), position: { x: 0, y: 100 } });
  await svall.open('map');
  await page.getByTestId(`island-label-${island.id}`).click();
  const card = page.getByTestId('side-island-card');
  await expect(card).toBeVisible();
  await card.getByTestId('side-island-name').fill('renamed island');
  await card.getByTestId('side-island-name').press('Enter');
  await expect(page.getByTestId(`island-label-${island.id}`)).toContainText('renamed island');
  await card.getByTestId('side-island-description').fill('what this island is for');
  await card.getByTestId('side-island-description').blur();
  await expect.poll(async () => (await svall.api.call('state.get', {})).islands[island.id].description).toBe('what this island is for');
  await card.getByTestId('side-island-instructions').fill('merge without asking');
  await card.getByTestId('side-island-instructions').blur();
  await expect.poll(async () => (await svall.api.call('state.get', {})).islands[island.id].instructions).toBe('merge without asking');
  await card.getByTestId('island-context-ref').fill('https://linear.app/x/issue/ENG-1');
  await card.getByTestId('island-context-add').click();
  await expect(card.getByTestId('side-island-context')).toContainText('linear.app/x/issue/ENG-1');
  await expect.poll(async () => (await svall.api.call('state.get', {})).islands[island.id].context[0]?.kind).toBe('linear');
  await card.getByTestId('island-context-remove').first().click();
  await expect(card.getByTestId('side-island-context')).not.toContainText('ENG-1');
  await card.getByTestId('side-island-new').click();
  await expect(page.getByTestId('terminal-card')).toBeVisible();
  await expect(card.getByTestId('side-island-delete')).toHaveCount(0);
  const created = (await page.getByTestId('terminal-card').getAttribute('data-char'))!;
  await svall.api.call('char.close', { id: created });
  await page.getByTestId(`island-label-${island.id}`).click();
  await expect(card.getByTestId('side-island-delete')).toBeVisible();
  await card.getByTestId('side-island-delete').click();
  await page.getByTestId('confirm-delete-island-cancel').click();
  await card.getByTestId('side-island-delete').click();
  await expect(page.getByTestId(`island-label-${island.id}`)).toHaveCount(1);
  await page.getByTestId('confirm-delete-island-delete').click();
  await expect(page.getByTestId(`island-label-${island.id}`)).toHaveCount(0);
  await expect(card).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('side-island-card')).toBeHidden();
  await page.keyboard.press('Meta+i');
  await expect(page.getByTestId('fleet-summary')).toBeVisible();
});

test('a dropped path lands on the island under the point', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('drop'), position: { x: 0, y: 100 } });
  await svall.open('map');
  const box = (await page.getByTestId(`island-${island.id}`).boundingBox())!;
  await page.evaluate(([x, y]) => window.__svall!.receive(JSON.stringify({ type: 'drag.drop', paths: ['/tmp'], x, y })), [box.x + box.width / 2, box.y + box.height / 2]);
  await expect.poll(async () => (await svall.api.call('state.get', {})).islands[island.id].context[0]?.kind).toBe('folder');
});

test('the side card shows the last command and steps back through earlier ones', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('cmd') });
  const shell = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'plain' });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'agent', command: FAKE_CLAUDE });
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].agent?.status, { timeout: 15_000 }).toBe('idle');
  await svall.api.call('char.run', { id: c.id, text: 'plant the flag' });
  await svall.api.call('char.run', { id: c.id, text: 'raise the sail' });
  await expect.poll(async () => (await svall.api.call('char.prompts', { id: c.id })).prompts).toEqual(['raise the sail', 'plant the flag']);

  await svall.open();
  await page.getByTestId(`sb-char-${c.id}`).click();
  const card = page.getByTestId('side-card');
  await expect(card.getByTestId('side-prompt-text')).toHaveText('raise the sail');
  await expect(card.getByTestId('side-prompt-pos')).toHaveText('1/2');

  await card.getByTestId('side-prompt-prev').click();
  await expect(card.getByTestId('side-prompt-text')).toHaveText('plant the flag');
  await expect(card.getByTestId('side-prompt-pos')).toHaveText('2/2');
  await expect(card.getByTestId('side-prompt-prev')).toBeDisabled();
  await card.getByTestId('side-prompt-next').click();
  await expect(card.getByTestId('side-prompt-text')).toHaveText('raise the sail');
  await expect(card.getByTestId('side-prompt-next')).toBeDisabled();

  // a prompt sent while the card is open reaches it
  await svall.api.call('char.run', { id: c.id, text: 'weigh anchor' });
  await expect(card.getByTestId('side-prompt-text')).toHaveText('weigh anchor');
  await expect(card.getByTestId('side-prompt-pos')).toHaveText('1/3');

  // a shell has no agent, so it has no commands to show
  await page.getByTestId(`sb-char-${shell.id}`).click();
  await expect(page.getByTestId('side-prompt')).toHaveCount(0);
});

test('a card lists its docs as the agent is told of them, and a row opens the shelf on that file', async ({ page, svall }) => {
  await page.setViewportSize({ width: 2100, height: 1000 });
  const island = await svall.api.call('island.create', { name: svall.uniq('isle') });
  const other = await svall.api.call('island.create', { name: svall.uniq('isle-other') });
  const dir = path.join(svall.home, 'docs', 'islands', island.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'architecture.md'), '---\ndescription: How the parts fit.\n---\n# Architecture\n');
  await svall.open('map');
  await page.getByTestId(`island-label-${island.id}`).click();

  const row = page.getByTestId('side-doc-architecture');
  await expect(row).toContainText('architecture');
  await expect(row).toContainText('How the parts fit.');

  await row.click();
  await expect(page.getByTestId('resources-shelf')).toBeVisible();
  await expect(page.getByTestId(`resources-where-r:${dir}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('resources-editor-crumb')).toContainText('architecture.md');

  await page.getByTestId('resources-close').click();
  await page.getByTestId(`island-label-${island.id}`).click();
  await page.getByTestId('side-docs-new').click();
  await expect(page.getByTestId('resources-new-doc-name')).toBeFocused();

  // a doc written to disk after the card opened still shows once the card is asked again
  await page.getByTestId('resources-close').click();
  fs.writeFileSync(path.join(dir, 'another.md'), '---\ndescription: Written after the card opened.\n---\n# Another\n');
  await page.getByTestId(`island-label-${other.id}`).click();
  await page.getByTestId(`island-label-${island.id}`).click();
  await expect(page.getByTestId('side-doc-another')).toContainText('Written after the card opened.');
});

test('a doc is deleted from the card without opening the shelf, and Undo brings it back', async ({ page, svall }) => {
  await page.setViewportSize({ width: 2100, height: 1000 });
  const island = await svall.api.call('island.create', { name: svall.uniq('isle') });
  const dir = path.join(svall.home, 'docs', 'islands', island.id);
  fs.mkdirSync(dir, { recursive: true });
  const text = '---\ndescription: Superseded.\n---\n';
  fs.writeFileSync(path.join(dir, 'old-plan.md'), text);
  await svall.open('map');
  await page.getByTestId(`island-label-${island.id}`).click();

  await page.getByTestId('side-doc-old-plan').hover();
  await page.getByTestId('side-doc-delete-old-plan').click();
  await expect(page.getByTestId('side-doc-old-plan')).toHaveCount(0);
  await expect(page.getByTestId('resources-shelf')).toHaveCount(0);
  expect(fs.existsSync(path.join(dir, 'old-plan.md'))).toBe(false);

  await expect(page.getByTestId('toast')).toContainText('Deleted old-plan');
  await page.getByTestId('toast-action').click();
  await expect(page.getByTestId('side-doc-old-plan')).toBeVisible();
  expect(fs.readFileSync(path.join(dir, 'old-plan.md'), 'utf8')).toBe(text);
});

test('clicking the cwd copies it', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('copy') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'copy-cwd' });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await svall.open();
  await page.getByTestId(`sb-char-${c.id}`).click();
  const cwd = page.getByTestId('side-card').getByTestId('side-cwd');
  await cwd.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(await cwd.textContent());
});

const widthOf = async (page: Page, testId: string): Promise<number> => (await page.getByTestId(testId).boundingBox())!.width;

async function drag(page: Page, testId: string, dx: number): Promise<void> {
  const grip = (await page.getByTestId(testId).boundingBox())!;
  const y = grip.y + grip.height / 4;
  await page.mouse.move(grip.x + grip.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + dx, y, { steps: 4 });
  await page.mouse.up();
}

test('both sidebars are dragged wider and come back that wide', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('grips') });
  await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'grips' });
  await svall.open('map');
  await page.getByTestId('side-show').click();
  const islands = await widthOf(page, 'sidebar');
  const card = await widthOf(page, 'fleet-summary');

  await drag(page, 'side-drag-sidebar', 60);
  await expect.poll(() => widthOf(page, 'sidebar')).toBeCloseTo(islands + 60, -1);
  await drag(page, 'side-drag-card', -70);
  await expect.poll(() => widthOf(page, 'fleet-summary')).toBeCloseTo(card + 70, -1);

  await svall.open('map');
  await page.getByTestId('side-show').click();
  expect(await widthOf(page, 'sidebar')).toBeCloseTo(islands + 60, -1);
  expect(await widthOf(page, 'fleet-summary')).toBeCloseTo(card + 70, -1);
});

test('a character takes an agent profile in the side card, and the shelf shows what it says', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('profile') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'profiled' });
  await svall.open();
  await page.getByTestId(`sb-char-${c.id}`).click();
  const card = page.getByTestId('side-card');
  await expect(card.getByText('Agent instructions', { exact: true })).toBeVisible();

  const pick = card.getByTestId('side-agent-profile');
  await pick.click();
  await card.getByTestId('side-agent-profile-opt-reviewer').click();
  await expect(pick).toHaveText('reviewer');
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].agentProfile).toBe('reviewer');
  await expect(card.getByTestId('side-agent-profile-hint')).toContainText('Independently reviews completed code');
  expect((await svall.api.call('char.show', { id: c.id })).text).toContain('Agent profile: reviewer — follow this role.');

  await card.getByTestId('side-agent-profile-view').click();
  await expect(page.getByTestId('resources-editor-crumb')).toHaveText(/Fleet\s*\/\s*.+\s*\/\s*Agent profiles\s*\/\s*reviewer\.md/);
  await expect(page.getByTestId('resources-doc-description')).toHaveValue(/Independently reviews completed code/);
  await expect(page.locator('.res-editor .cm-content')).toContainText('You are an independent code reviewer.');
  await page.getByTestId('resources-close').click();

  // the menu's keys stay out of the page's: Escape shuts the menu and leaves the card open
  await pick.focus();
  await page.keyboard.press('ArrowDown');
  await expect(card.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card.getByRole('listbox')).toHaveCount(0);
  await expect(card).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(pick).toHaveText('No profile');
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].agentProfile).toBeUndefined();
  await expect(card.getByTestId('side-agent-profile-hint')).toHaveCount(0);
});

test('a profile whose file is gone is named missing, and the brief goes without it', async ({ page, svall }) => {
  const file = path.join(svall.home, 'agent-profiles', 'fleeting.md');
  fs.writeFileSync(file, '---\ndescription: here for a moment\n---\n\nYou are fleeting.\n');
  const island = await svall.api.call('island.create', { name: svall.uniq('gone') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'bereft', agentProfile: 'fleeting' });
  fs.rmSync(file);
  await svall.open();
  await page.getByTestId(`sb-char-${c.id}`).click();
  const card = page.getByTestId('side-card');
  await expect(card.getByTestId('side-agent-profile')).toHaveText('fleeting (missing)');
  await expect(card.getByTestId('side-agent-profile-hint')).toHaveText('fleeting.md is not in the agent profiles folder');
  await expect(card.getByTestId('side-agent-profile-view')).toHaveCount(0);
  expect((await svall.api.call('char.show', { id: c.id })).text).not.toContain('Agent profile');
});
