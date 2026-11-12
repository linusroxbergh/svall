// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { freshStore } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

// a ResizeObserver whose watched elements a test can see, and resize
const watching = new Set<{ targets: Set<Element>; fire(): void }>();
globalThis.ResizeObserver = class {
  targets = new Set<Element>();
  constructor(private readonly cb: ResizeObserverCallback) { watching.add(this); }
  fire() { this.cb([], this as unknown as ResizeObserver); }
  observe(e: Element) { this.targets.add(e); }
  unobserve(e: Element) { this.targets.delete(e); }
  disconnect() { this.targets.clear(); watching.delete(this); }
} as unknown as typeof ResizeObserver;
const resized = (e: Element) => act(() => { for (const o of watching) if (o.targets.has(e)) o.fire(); });

const { Section } = await import('../../src/Section.js');

beforeEach(() => freshStore());

const box = (top: number, bottom: number) => () => ({ top, bottom, height: bottom - top }) as DOMRect;
// rows one under another, each with 4px under its words; `bottoms`, where each row ends
const lay = (body: HTMLElement, bottoms: number[]) => {
  Object.defineProperty(body, 'scrollHeight', { value: bottoms.at(-1)!, configurable: true });
  [...body.querySelectorAll<HTMLElement>('.row')].forEach((r, i) => { r.getBoundingClientRect = box(bottoms[i - 1] ?? 0, bottoms[i]); });
};
// a body 100px tall over those rows
function squeezed(bottoms: number[]) {
  const view = render(
    <Section name="robot.details" title="Details"><div className="rows">{bottoms.map((b) => <div key={b} className="row" style={{ paddingBottom: '4px' }} />)}</div></Section>,
  );
  const body = view.container.querySelector<HTMLElement>('.sec-body')!;
  Object.defineProperties(body, { clientHeight: { value: 100 }, scrollTop: { value: 0 } });
  body.getBoundingClientRect = box(0, 100);
  lay(body, bottoms);
  fireEvent.scroll(body);
  return Object.assign(body, { unmount: view.unmount });
}

test('a squeezed section keeps its whole rows crisp, its fade starting at the row the edge cuts', () => {
  const body = squeezed([40, 80, 120]);
  expect([body.dataset.more, body.dataset.whole, body.style.getPropertyValue('--whole')]).toEqual(['true', 'cut', '80px']);
});

test('a squeezed section whose edge cuts only the space under a row\'s words shows them all, unfaded', () => {
  const body = squeezed([40, 80, 102]);
  expect([body.dataset.whole, body.style.getPropertyValue('--whole')]).toEqual(['all', '']);
});

test('a section the edge cuts through its first row keeps the fade over its foot', () => {
  const body = squeezed([160]);
  expect([body.dataset.more, body.dataset.whole]).toEqual(['true', undefined]);
});

test('a row that grows in a squeezed section moves where its fade starts, with no scroll', () => {
  const body = squeezed([40, 80, 102]);
  expect(body.dataset.whole).toBe('all');
  // the second row's details open: it grows, and the third row is cut
  lay(body, [40, 100, 140]);
  resized(body.querySelectorAll('.row')[1]);
  expect([body.dataset.whole, body.style.getPropertyValue('--whole')]).toEqual(['cut', '100px']);
});

test('a section that goes stops watching its rows', () => {
  const body = squeezed([40, 80, 120]);
  const row = body.querySelector('.row')!;
  expect([...watching].some((o) => o.targets.has(row))).toBe(true);
  body.unmount();
  expect([...watching].some((o) => o.targets.has(row) || o.targets.has(body))).toBe(false);
});
