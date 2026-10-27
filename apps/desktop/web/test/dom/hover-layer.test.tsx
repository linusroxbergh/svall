// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { chr, isl } from '../fixtures.js';
import { freshStore } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { HoverLayer } = await import('../../src/map/hover.js');
const { sharedCardScale } = await import('../../src/map/layout.js');
const { theme } = await import('../../src/theme.js');

beforeEach(() => freshStore());

test('the hover card over a robot on a worker clears the band above its card', () => {
  const island = isl('i_a', 'alpha', 0, { position: { x: 0, y: 20 } });
  const layout = { scale: 1, tile: theme.cell, ox: 0, oy: 0 };
  const place = { mode: 'pair' as const, homeShift: 0, cx: 0, scale: 1, homeScale: 1 };
  const host = { w: 2000, h: 4000 };
  const c = chr('c0', 'i_a', { x: 2, y: 2 });
  const { rerender } = render(<HoverLayer c={c} island={island} layout={layout} place={place} host={host} />);
  const top = () => parseFloat(screen.getByTestId('hover-card').style.top);
  const here = top();
  rerender(<HoverLayer c={{ ...c, machine: '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId }} island={island} layout={layout} place={place} host={host} />);
  expect(here - top()).toBeCloseTo(theme.token.band * theme.token.unit * sharedCardScale(1, 1));
});
