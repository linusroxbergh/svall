/// <reference types="node" />
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test } from 'vitest';

test('the deployed entry point shares durable reservations across concurrent callers and runtime restarts', async () => {
  // Use pinned Wrangler's own emulator, so this exercises the same runtime as wrangler dev without another version.
  const require = createRequire(import.meta.url);
  const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve('wrangler'))('miniflare');
  const dir = await mkdtemp(path.join(tmpdir(), 'svall-feedback-runtime-'));
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../src/worker.ts', import.meta.url))],
    bundle: true, format: 'esm', write: false, external: ['cloudflare:workers'],
  });
  const options = convertV4MiniflareOptions({
    name: 'svall-feedback-test', rootPath: dir, modulesRoot: dir, modules: true,
    script: bundled.outputFiles[0]!.text,
    compatibilityDate: '2026-10-01',
    durableObjects: { BUDGET: { className: 'FeedbackBudget', useSQLite: true } },
    resourcePersistencePath: path.join(dir, 'storage'),
  });
  let runtime = new Miniflare(options);
  try {
    const { BUDGET } = await runtime.getBindings();
    // Separate stubs represent independent callers/locations, all naming the same destination.
    const replies: Response[] = await Promise.all(Array.from({ length: 100 }, () =>
      BUDGET.getByName('linusroxbergh/svall-feedback').fetch('https://budget/reserve', { method: 'POST' })));
    expect(replies.filter((r) => r.status === 204)).toHaveLength(30);
    expect(replies.filter((r) => r.status === 429)).toHaveLength(70);
    await runtime.dispose();
    runtime = new Miniflare(options);
    const restarted = await runtime.getBindings();
    const response = await restarted.BUDGET.getByName('linusroxbergh/svall-feedback')
      .fetch('https://budget/reserve', { method: 'POST' });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
