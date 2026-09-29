import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const swift = fs.readFileSync(new URL('../../mac/Sources/Svall/OnePassword.swift', import.meta.url), 'utf8');
const js = swift.split('static let fill = """')[1].split('"""')[0];
type Secret = { pageOrigin: string; username: string; password: string; otp: string };
const run = (page: Page, args: Secret) =>
  page.evaluate(([body, a]) => new Function('pageOrigin', 'username', 'password', 'otp', body as string)((a as Secret).pageOrigin, (a as Secret).username, (a as Secret).password, (a as Secret).otp), [js, args] as const);
const secret = { username: 'linus', password: 'hunter2', otp: '123456' };
// the script fills only where it was sent, so every case but the last says it is on the page it is looking at
const here = (page: Page) => page.evaluate(() => location.origin);

test('password form', async ({ page }) => {
  await page.setContent('<form><input type="search" name="q"><input type="hidden" name="csrf"><input type="text" name="login" id="u"><input type="password" id="p"></form><script>window.seen=[];for(const i of document.querySelectorAll("input"))i.addEventListener("input",e=>seen.push(e.target.id))</script>');
  expect(await run(page, { ...secret, pageOrigin: await here(page) })).toBe('password');
  expect(await page.inputValue('#u')).toBe('linus');
  expect(await page.inputValue('#p')).toBe('hunter2');
  expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual(['u', 'p']);
});

test('username-first step, then the code page', async ({ page }) => {
  await page.setContent('<input type="email" id="identifierId" name="identifier"><input type="password" style="display:none" id="hidden">');
  const pageOrigin = await here(page);
  expect(await run(page, { ...secret, pageOrigin })).toBe('username');
  expect(await page.inputValue('#identifierId')).toBe('linus');
  await page.setContent('<input type="text" autocomplete="one-time-code" id="c">');
  expect(await run(page, { ...secret, pageOrigin })).toBe('code');
  expect(await page.inputValue('#c')).toBe('123456');
  await page.setContent('<input type="text" name="q">');
  expect(await run(page, { ...secret, pageOrigin })).toBe('none');
});

// a code page often keeps a password field the user cannot see, as a hint to password managers
test('a password field nobody can see leaves the code page to the code', async ({ page }) => {
  for (const hidden of ['position:absolute;left:-9999px', 'visibility:hidden', 'opacity:0']) {
    await page.setContent(`<input type="password" style="${hidden}" id="p"><input type="text" autocomplete="one-time-code" id="c">`);
    expect(await run(page, { ...secret, pageOrigin: await here(page) })).toBe('code');
    expect(await page.inputValue('#c')).toBe('123456');
    expect(await page.inputValue('#p')).toBe('');
  }
});

test('a page that moved to another host keeps its fields', async ({ page }) => {
  await page.setContent('<input type="text" name="login" id="u"><input type="password" id="p">');
  expect(await run(page, { ...secret, pageOrigin: 'https://github.com' })).toBe('moved');
  expect(await page.inputValue('#u')).toBe('');
  expect(await page.inputValue('#p')).toBe('');
});
