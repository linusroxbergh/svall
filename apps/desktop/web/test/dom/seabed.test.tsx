// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Seabed } from '../../src/map/Relief.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
let reads: string[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('Path2D', class {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform() {}, fill() {} } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => reads.shift() ?? PNG);
  HTMLImageElement.prototype.decode = () => Promise.resolve();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const glow = (container: HTMLElement) => container.querySelector('image')?.getAttribute('href');
const drawn = () => vi.mocked(HTMLCanvasElement.prototype.toDataURL).mock.calls.length;

// a canvas WebKit's GPU process doesn't answer for in time reads back as 'data:,', which an <image> paints as its broken-image icon
test('a glow that reads back empty is left out and drawn again each second until it reads back', async () => {
  reads = ['data:,', 'data:,'];
  const { container } = render(<svg><Seabed sand="M10 10L90 10L90 60Z" cx={50} cy={35} bank="#000" /></svg>);
  expect(glow(container)).toBeUndefined();
  await act(async () => { vi.advanceTimersByTime(999); });
  expect(drawn()).toBe(1);
  await act(async () => { vi.advanceTimersByTime(1); });
  expect([drawn(), glow(container)]).toEqual([2, undefined]);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(glow(container)).toBe(PNG);
});

test('a coast whose glow reads back empty keeps the last glow until its own is drawn', async () => {
  reads = [];
  const { container, rerender } = render(<svg><Seabed sand="M20 20L80 20L80 70Z" cx={50} cy={45} bank="#000" /></svg>);
  expect(glow(container)).toBe(PNG);
  reads = ['data:,', `${PNG}A`];
  rerender(<svg><Seabed sand="M20 20L80 20L80 75Z" cx={50} cy={48} bank="#000" /></svg>);
  await act(async () => {});
  expect(glow(container)).toBe(PNG);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(glow(container)).toBe(`${PNG}A`);
});
