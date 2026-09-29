// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// the shell runs this script in the tab as the body of an async function whose arguments are its locals
const swift = fs.readFileSync(path.join(import.meta.dirname, '../../mac/Sources/Svall/OnePassword.swift'), 'utf8');
const [, body, indent] = swift.match(/static let fill = """\n([\s\S]*?)\n( *)"""/)!;
const script = body!.split('\n').map((l) => l.slice(indent!.length)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const fill = (args: Record<string, string>): Promise<string> => new AsyncFunction(...Object.keys(args), script)(...Object.values(args));
const password = () => document.querySelector<HTMLInputElement>('input[type=password]')!.value;

beforeEach(() => {
  document.body.innerHTML = '<input type="email" name="email"><input type="password">';
  for (const e of document.querySelectorAll('input')) {
    e.getBoundingClientRect = () => ({ width: 100, height: 20, right: 100, bottom: 20 }) as DOMRect;
    e.checkVisibility = () => true;
  }
});

describe('1Password fill script', () => {
  it('fills a page served on a port', async () => {
    expect(location.origin).toBe('http://localhost:3000');
    expect(await fill({ pageOrigin: 'http://localhost:3000', username: 'u@x.test', password: 'pw', otp: '' })).toBe('password');
    expect(password()).toBe('pw');
  });

  it('fills nothing once the tab is on another scheme, host or port', async () => {
    for (const pageOrigin of ['http://localhost', 'https://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000']) {
      expect(await fill({ pageOrigin, username: 'u@x.test', password: 'pw', otp: '' })).toBe('moved');
    }
    expect(password()).toBe('');
  });

  // the page's own window.origin must not stand in for the one the shell sends
  it('fills nothing when sent no origin', async () => {
    await expect(fill({ username: 'u@x.test', password: 'pw', otp: '' })).rejects.toThrow();
    expect(password()).toBe('');
  });
});
