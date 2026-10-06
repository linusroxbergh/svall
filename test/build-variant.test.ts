import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

const ROOT = path.join(import.meta.dirname, '..');
const read = (plist: string, key: string) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

test('the dev variant renames the app and drops the update feed', () => {
  const plist = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'Info.plist');
  fs.copyFileSync(path.join(ROOT, 'apps/desktop/mac/Info.plist'), plist);
  execFileSync(path.join(ROOT, 'apps/desktop/mac/variant-plist.sh'), [plist, 'dev']);
  expect(read(plist, 'CFBundleIdentifier')).toBe('io.github.linusroxbergh.svall.dev');
  expect(read(plist, 'CFBundleName')).toBe('Svall Dev');
  expect(read(plist, 'SvallHomeName')).toBe('.svall-dev');
  expect(() => read(plist, 'SUFeedURL')).toThrow();
});

test('the release variant keeps the repo Info.plist as it is', () => {
  const plist = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'Info.plist');
  fs.copyFileSync(path.join(ROOT, 'apps/desktop/mac/Info.plist'), plist);
  execFileSync(path.join(ROOT, 'apps/desktop/mac/variant-plist.sh'), [plist, 'release']);
  expect(read(plist, 'CFBundleIdentifier')).toBe('io.github.linusroxbergh.svall');
  expect(read(plist, 'SvallHomeName')).toBe('.svall');
});

// a scheduled check that finds an update holds it until the app quits, so the app probes the feed on the interval itself
test("Sparkle's own scheduled checks stay off, and the interval the app probes on is set", () => {
  const plist = path.join(ROOT, 'apps/desktop/mac/Info.plist');
  expect(read(plist, 'SUEnableAutomaticChecks')).toBe('false');
  expect(Number(read(plist, 'SUScheduledCheckInterval'))).toBeGreaterThan(0);
});
