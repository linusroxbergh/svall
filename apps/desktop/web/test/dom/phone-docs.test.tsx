// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ResourceSource } from '@svall/protocol';
import { expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';

const ROOT = 'r:/d/islands/i1';
const plan = { id: 'd:plan', name: 'plan', detail: 'When to read.', reveal: '/d/islands/i1/plan.md', target: 'file' as const, open: { rootId: ROOT, path: 'plan.md' } };
const source: ResourceSource = { rootId: ROOT, root: '/d/islands/i1', name: 'isle', tier: 'island', docs: ROOT, islandIds: ['i1'], characterIds: [], groups: [{ kind: 'docs', items: [plan] }] };
let store: AppStore;
const call = (m: string) => Promise.resolve(m === 'resources.get' ? { sources: [source] } : { text: '---\ndescription: When to read.\n---\n# Plan\n', mtimeMs: 1 });
vi.mock('../../src/mobile/boot.js', () => ({ phone: { api: () => ({ call }), get store() { return store; } } }));
const { DocsList } = await import('../../src/mobile/DocsList.js');

test('the phone reads a doc without its frontmatter', async () => {
  store = createAppStore();
  setAppStore(store);
  store.getState().setResources([source]);
  render(<DocsList tier="island" id="i1" />);
  await act(async () => { fireEvent.click(screen.getByText('plan')); });
  expect(screen.getByRole('dialog', { name: 'plan' }).querySelector('pre')!.textContent).toBe('# Plan\n');
});
