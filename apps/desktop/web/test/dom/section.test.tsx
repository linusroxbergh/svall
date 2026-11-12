// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { freshStore } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Section } = await import('../../src/Section.js');

beforeEach(() => freshStore());

// a body 100px tall over rows one under another, each with 4px under its words; `bottoms`, where each row ends
function squeezed(bottoms: number[]) {
  const { container } = render(
    <Section name="robot.details" title="Details"><div className="rows">{bottoms.map((b) => <div key={b} className="row" style={{ paddingBottom: '4px' }} />)}</div></Section>,
  );
  const body = container.querySelector<HTMLElement>('.sec-body')!;
  const box = (top: number, bottom: number) => () => ({ top, bottom, height: bottom - top }) as DOMRect;
  Object.defineProperties(body, { clientHeight: { value: 100 }, scrollHeight: { value: bottoms.at(-1)! }, scrollTop: { value: 0 } });
  body.getBoundingClientRect = box(0, 100);
  [...body.querySelectorAll<HTMLElement>('.row')].forEach((r, i) => { r.getBoundingClientRect = box(bottoms[i - 1] ?? 0, bottoms[i]); });
  fireEvent.scroll(body);
  return body;
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
