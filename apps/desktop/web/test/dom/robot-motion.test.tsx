// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRobot, REST, setMotion, useRobotMotion } from '../../src/map/motion.js';
import { inlineRobot, Robot } from '../../src/map/Robot.js';
import { robotUrl } from '../../src/portraits.js';
import { freshStore, store } from './harness.js';

const reduce: { matches: boolean; change?: () => void } = { matches: false };
window.matchMedia = ((media: string) => ({
  media, get matches() { return reduce.matches; },
  addEventListener: (_: string, f: () => void) => { reduce.change = f; }, removeEventListener() {},
})) as never;

const removes: (() => void)[] = [];

// a robot on a card with the given status; an action it plays moves two parts and lasts until end() is called
function robot(status: string) {
  const card = document.createElement('div');
  card.dataset.status = status;
  card.innerHTML = '<svg data-idle="blink" data-work="type"></svg>';
  document.body.append(card);
  const bot = card.firstElementChild as SVGElement;
  const r = { bot, parts: [] as { finished: Promise<void>; playbackRate: number }[], end: () => {} };
  Object.assign(bot, {
    getAnimations: () => {
      if (!bot.dataset.act) return [];
      const finished = new Promise<void>((done) => { r.end = done; });
      r.parts = [{ finished, playbackRate: 1 }, { finished, playbackRate: 1 }];
      return r.parts;
    },
  });
  removes.push(addRobot(bot));
  return r;
}

const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const LONGEST = REST.idle * 1.1;

describe('the robot scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // the shortest rests and quickest actions, and the first action on each list
    vi.spyOn(Math, 'random').mockReturnValue(0);
    freshStore();
    store.getState().setView('map');
    reduce.matches = false;
  });
  afterEach(() => {
    setMotion(false);
    for (const r of removes.splice(0)) r();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('plays an idle robot from its idle list and a working one from its work list', async () => {
    const idle = robot('idle'), busy = robot('working');
    setMotion(true);
    await tick();
    expect(idle.bot.dataset.act).toBe('blink');
    expect(busy.bot.dataset.act).toBe('type');
  });

  it('clears the action once its animations finish, then rests before the next', async () => {
    const r = robot('idle');
    setMotion(true);
    await tick();
    await tick(LONGEST * 2);
    expect(r.bot.dataset.act).toBe('blink');
    r.end();
    await tick();
    expect(r.bot.dataset.act).toBeUndefined();
    await tick(REST.idle * 0.9 - 1);
    expect(r.bot.dataset.act).toBeUndefined();
    await tick(2);
    expect(r.bot.dataset.act).toBe('blink');
  });

  it('rests its centre give or take a tenth, after a first rest anywhere up to the centre', async () => {
    const random = vi.mocked(Math.random);
    random.mockReturnValue(0.5);
    const idle = robot('idle'), busy = robot('working');
    setMotion(true);
    await tick(REST.working / 2 - 1);
    expect(busy.bot.dataset.act).toBeUndefined();
    await tick(2);
    expect(busy.bot.dataset.act).toBe('type');
    await tick(REST.idle / 2 - REST.working / 2 - 2);
    expect(idle.bot.dataset.act).toBeUndefined();
    await tick(2);
    expect(idle.bot.dataset.act).toBe('blink');
    for (const [r, scale] of [[0.9999, 1.1], [0, 0.9]] as const) {
      random.mockReturnValue(r);
      idle.end();
      await tick();
      await tick(REST.idle * scale - 2);
      expect(idle.bot.dataset.act).toBeUndefined();
      await tick(4);
      expect(idle.bot.dataset.act).toBe('blink');
    }
  });

  it('plays every part of an action at one rate, its length give or take a tenth', async () => {
    const random = vi.mocked(Math.random);
    const r = robot('idle');
    setMotion(true);
    await tick();
    expect(r.parts[0].playbackRate).toBeCloseTo(1 / 0.9);
    expect(r.parts[1].playbackRate).toBe(r.parts[0].playbackRate);
    random.mockReturnValue(0.9999);
    r.end();
    await tick(LONGEST + 1);
    expect(r.parts[0].playbackRate).toBeCloseTo(1 / 1.1);
    expect(r.parts[1].playbackRate).toBe(r.parts[0].playbackRate);
    // a fresh draw on every call, and the parts still share one
    let draw = 0;
    random.mockImplementation(() => (draw = (draw + 0.37) % 1));
    r.end();
    await tick(LONGEST + 1);
    expect(r.bot.dataset.act).toBe('blink');
    expect(r.parts[1].playbackRate).toBe(r.parts[0].playbackRate);
  });

  it('stills every robot while the map is paused, a character window is open or the switch is off', async () => {
    const r = robot('idle');
    renderHook(() => useRobotMotion());
    await tick();
    expect(r.bot.dataset.act).toBe('blink');
    const s = store.getState();
    for (const [stop, go] of [
      [() => s.setActive(false), () => s.setActive(true)],
      [() => s.focus('c0'), () => s.closeCard()],
      [() => s.setSettings({ robotMotion: false }), () => s.setSettings({ robotMotion: true })],
    ]) {
      act(stop);
      expect(r.bot.dataset.act).toBeUndefined();
      await tick(LONGEST);
      expect(r.bot.dataset.act).toBeUndefined();
      act(go);
      await tick();
      expect(r.bot.dataset.act).toBe('blink');
    }
    // stopped during a rest, the rest never ends in an action
    r.end();
    await tick();
    act(() => s.setActive(false));
    await tick(LONGEST);
    expect(r.bot.dataset.act).toBeUndefined();
  });

  it('keeps robots still while motion is reduced', async () => {
    reduce.matches = true;
    const r = robot('idle');
    renderHook(() => useRobotMotion());
    await tick(LONGEST);
    expect(r.bot.dataset.act).toBeUndefined();
    act(() => { reduce.matches = false; reduce.change?.(); });
    await tick();
    expect(r.bot.dataset.act).toBe('blink');
    act(() => { reduce.matches = true; reduce.change?.(); });
    expect(r.bot.dataset.act).toBeUndefined();
  });
});

const robotsDir = path.join(__dirname, '../../public/robots');
const files = fs.readdirSync(robotsDir).filter((f) => /^robot-\d+\.svg$/.test(f));
const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
const refs = (svg: string) => [
  ...Array.from(svg.matchAll(/url\(['"]?#([^'")]+)/g), (m) => m[1]),
  ...Array.from(svg.matchAll(/\s(?:xlink:)?href="#([^"]+)"/g), (m) => m[1]),
  ...Array.from(svg.matchAll(/\saria-labelledby="([^"]+)"/g), (m) => m[1].split(/\s+/)).flat(),
];

describe('a robot inlined on a card', () => {
  it('prefixes every id and every reference to one, and leaves references to nothing alone', () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" class="r07" role="img" aria-labelledby="t">'
      + '<title id="t">T</title>'
      + '<linearGradient id="g"/><path id="blade"/><rect fill="url(#g)"/><rect fill="url(\'#g\')"/><use href="#blade"/><use xlink:href="#blade"/><rect fill="url(#gone)"/></svg>';
    const out = inlineRobot(src, 'bot3');
    expect(Array.from(out.matchAll(/\sid="([^"]+)"/g), (m) => m[1])).toEqual(['bot3-t', 'bot3-g', 'bot3-blade']);
    expect(refs(out)).toEqual(['bot3-g', 'bot3-g', 'gone', 'bot3-blade', 'bot3-blade', 'bot3-t']);
    const root = parse(out);
    expect(root.getAttribute('class')).toBe('r07 portrait robot');
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(parse(inlineRobot('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>', 'p')).getAttribute('class')).toBe('portrait robot');
  });

  it.each(files)('%s keeps its references inside its own copy and changes nothing else', (f) => {
    const src = fs.readFileSync(path.join(robotsDir, f), 'utf8');
    const out = inlineRobot(src, 'QQ');
    const ids = Array.from(out.matchAll(/\sid="([^"]+)"/g), (m) => m[1]);
    for (const id of ids) expect(id.startsWith('QQ-')).toBe(true);
    for (const ref of refs(out)) expect(ids).toContain(ref);
    const plain = out.replaceAll('QQ-', '');
    const body = (s: string) => s.slice(s.indexOf('>') + 1);
    expect(body(plain)).toBe(body(src));
    const attrs = (s: string) => Object.fromEntries([...parse(s).attributes].map((a) => [a.name, a.value]));
    const { class: cls, 'aria-hidden': hidden, preserveAspectRatio: _, ...rest } = attrs(plain);
    expect({ ...rest, class: cls.replace(/ ?portrait robot$/, '') }).toEqual({ ...attrs(src), class: attrs(src).class ?? '' });
    expect(hidden).toBe('true');
  });

  it('shows the img until the text arrives, then each card its own inline copy from one fetch', async () => {
    const src = fs.readFileSync(path.join(robotsDir, 'robot-07.svg'), 'utf8');
    const fetch = vi.fn(async () => new Response(src));
    vi.stubGlobal('fetch', fetch);
    try {
      const { container } = render(<><div className="a"><Robot n={7} /></div><div className="b"><Robot n={7} /></div></>);
      expect(container.querySelectorAll('img.portrait.robot')).toHaveLength(2);
      expect(container.querySelector('img')!.getAttribute('src')).toBe(robotUrl(7));
      await act(async () => {});
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(container.querySelector('img')).toBeNull();
      const [a, b] = [...container.querySelectorAll('.stage > svg.portrait.robot')];
      expect(a.getAttribute('aria-hidden')).toBe('true');
      const idsOf = (el: Element) => [...el.querySelectorAll('[id]')].map((e) => e.id);
      expect(idsOf(a).length).toBeGreaterThan(0);
      expect(idsOf(a).filter((id) => idsOf(b).includes(id))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
