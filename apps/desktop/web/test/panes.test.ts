import { describe, expect, it } from 'vitest';
import { SINGLE, closeSide, kindOf, mainLeft, pick, showBrowser, shows, snapRatio, split, toggleBrowserRight } from '../src/panes.js';

describe('panes', () => {
  it('starts on one terminal pane', () => {
    expect(SINGLE).toEqual({ left: 'terminal' });
  });
  it('splits to a terminal beside whatever is open', () => {
    expect(split({ left: 'terminal' })).toEqual({ left: 'terminal', right: 'terminal2' });
    expect(split({ left: 'terminal2' })).toEqual({ left: 'terminal2', right: 'terminal' });
    expect(split({ left: 'files' })).toEqual({ left: 'files', right: 'terminal' });
    expect(split({ left: 'files', right: 'changes' })).toEqual({ left: 'files', right: 'changes' });
  });
  it('closing a side leaves the other one alone on the left', () => {
    expect(closeSide({ left: 'terminal', right: 'files' }, 'right')).toEqual({ left: 'terminal' });
    expect(closeSide({ left: 'terminal', right: 'files' }, 'left')).toEqual({ left: 'files' });
    expect(closeSide({ left: 'terminal' }, 'left')).toEqual({ left: 'terminal' });
  });
  it('picking Terminal beside a terminal opens the other one', () => {
    expect(pick({ left: 'terminal', right: 'browser' }, 'right', 'terminal')).toEqual({ left: 'terminal', right: 'terminal2' });
    expect(pick({ left: 'terminal2', right: 'browser' }, 'right', 'terminal')).toEqual({ left: 'terminal2', right: 'terminal' });
    expect(pick({ left: 'files', right: 'browser' }, 'right', 'terminal')).toEqual({ left: 'files', right: 'terminal' });
    expect(pick({ left: 'terminal', right: 'terminal2' }, 'right', 'terminal')).toEqual({ left: 'terminal', right: 'terminal2' });
  });
  it('picking what the other side shows swaps the two', () => {
    expect(pick({ left: 'terminal', right: 'browser' }, 'left', 'browser')).toEqual({ left: 'browser', right: 'terminal' });
    expect(pick({ left: 'files', right: 'changes' }, 'right', 'files')).toEqual({ left: 'changes', right: 'files' });
    expect(pick({ left: 'terminal' }, 'left', 'files')).toEqual({ left: 'files' });
  });
  it('the keys put the main terminal, or a kind, on the left, swapping rather than opening a second terminal', () => {
    expect(mainLeft({ left: 'files', right: 'terminal' }, 'terminal')).toEqual({ left: 'terminal', right: 'files' });
    expect(mainLeft({ left: 'terminal2', right: 'browser' }, 'terminal')).toEqual({ left: 'terminal', right: 'browser' });
    expect(mainLeft({ left: 'terminal', right: 'browser' }, 'browser')).toEqual({ left: 'browser', right: 'terminal' });
    expect(mainLeft({ left: 'terminal' }, 'changes')).toEqual({ left: 'changes' });
  });
  it('the browser key opens it on the right, closes it there, and turns a lone browser back to the terminal', () => {
    expect(toggleBrowserRight({ left: 'terminal' })).toEqual({ left: 'terminal', right: 'browser' });
    expect(toggleBrowserRight({ left: 'terminal', right: 'browser' })).toEqual({ left: 'terminal' });
    expect(toggleBrowserRight({ left: 'terminal', right: 'files' })).toEqual({ left: 'terminal', right: 'browser' });
    expect(toggleBrowserRight({ left: 'browser' })).toEqual({ left: 'terminal' });
    expect(toggleBrowserRight({ left: 'browser', right: 'files' })).toEqual({ left: 'files', right: 'browser' });
  });
  it('the address bar key makes the browser visible without moving it', () => {
    expect(showBrowser({ left: 'terminal' })).toEqual({ left: 'terminal', right: 'browser' });
    expect(showBrowser({ left: 'browser' })).toEqual({ left: 'browser' });
    expect(showBrowser({ left: 'terminal', right: 'files' })).toEqual({ left: 'terminal', right: 'browser' });
  });
  it('names kinds and membership', () => {
    expect(kindOf('terminal2')).toBe('terminal');
    expect(shows({ left: 'terminal', right: 'files' }, 'files')).toBe(true);
    expect(shows({ left: 'terminal' }, 'terminal2')).toBe(false);
  });
  it('keeps the divider between a quarter and three quarters, and snaps to the middle', () => {
    expect(snapRatio(0.1)).toBe(0.25);
    expect(snapRatio(0.9)).toBe(0.75);
    expect(snapRatio(0.515)).toBe(0.5);
    expect(snapRatio(0.6)).toBe(0.6);
  });
});
