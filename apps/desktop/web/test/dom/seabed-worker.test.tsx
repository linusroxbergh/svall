// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Seabed } from '../../src/map/Relief.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
type Post = { id: number; sand: string; cx: number; cy: number };
type Fake = { posts: Post[]; onmessage?: (e: { data: unknown }) => void; onerror?: () => void };
const workers: Fake[] = [];
const posts = () => workers.flatMap((w) => w.posts);
const reply = (p: Post, g: unknown) => workers.find((w) => w.posts.includes(p))!.onmessage!({ data: { id: p.id, g } });

beforeEach(() => {
  vi.stubGlobal('Path2D', class {});
  vi.stubGlobal('OffscreenCanvas', class {});
  vi.stubGlobal('Worker', class {
    posts: Post[] = [];
    constructor() { workers.push(this); }
    postMessage(m: Post) { this.posts.push(m); }
    terminate() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform() {}, fill() {} } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG);
  HTMLImageElement.prototype.decode = () => Promise.resolve();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const glow = (container: HTMLElement) => container.querySelector('image')?.getAttribute('href');
const drawn = () => vi.mocked(HTMLCanvasElement.prototype.toDataURL).mock.calls.length;
const seabed = (h: number) => <svg><Seabed sand={`M10 10L90 10L90 ${h}Z`} cx={50} cy={h / 2} bank="#000" /></svg>;

test('a resized coast keeps its glow while a worker draws the new one, and the main thread draws only the first', async () => {
  const { container, rerender } = render(seabed(60));
  expect([drawn(), glow(container)]).toEqual([1, PNG]);
  rerender(seabed(64));
  await act(async () => {});
  expect([drawn(), glow(container), posts().map((p) => p.sand)]).toEqual([1, PNG, ['M10 10L90 10L90 64Z']]);
  await act(async () => { reply(posts()[0], { href: `${PNG}B`, x: 0, y: 0, w: 10, h: 10 }); });
  expect(glow(container)).toBe(`${PNG}B`);
});

test('a worker that fails hands its coast and every later one back to the main thread', async () => {
  const { container, rerender } = render(seabed(70));
  rerender(seabed(74));
  await act(async () => {});
  const posted = posts().length;
  vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue(`${PNG}C`);
  await act(async () => { workers[0].onerror!(); });
  expect([drawn(), glow(container)]).toEqual([2, `${PNG}C`]);
  rerender(seabed(78));
  await act(async () => {});
  expect([drawn(), posts().length]).toEqual([3, posted]);
});
