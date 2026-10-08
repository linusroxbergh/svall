import { useEffect, useSyncExternalStore } from 'react';
import { useApp } from '../hooks.js';

// Each robot rests, then plays one action from its own list (data-work while its card is working, else data-idle);
// an action is the CSS animations its SVG keys on data-act. Rests and action lengths vary up to a tenth either way
export const REST = { idle: 3500, working: 2000 } as const;
const jitter = () => 0.9 + Math.random() * 0.2;

type Run = { timer?: ReturnType<typeof setTimeout> };
const bots = new Map<SVGElement, Run>();
let on = false;

const working = (bot: SVGElement) => bot.closest('[data-status]')?.getAttribute('data-status') === 'working';

function rest(bot: SVGElement, first = false): void {
  const run = bots.get(bot)!;
  const centre = REST[working(bot) ? 'working' : 'idle'];
  // the first rest starts robots out of step
  run.timer = setTimeout(() => void play(bot, run), centre * (first ? Math.random() : jitter()));
}

async function play(bot: SVGElement, run: Run): Promise<void> {
  const acts = ((working(bot) ? bot.dataset.work : bot.dataset.idle) ?? '').split(' ').filter(Boolean);
  if (acts.length) {
    bot.dataset.act = acts[Math.floor(Math.random() * acts.length)];
    const parts = bot.getAnimations({ subtree: true });
    // one rate for every part, so they stay in step
    const rate = 1 / jitter();
    for (const a of parts) a.playbackRate = rate;
    await Promise.all(parts.map((a) => a.finished.catch(() => {})));
    // stopped or removed while it played
    if (bots.get(bot) !== run) return;
    delete bot.dataset.act;
  }
  rest(bot);
}

function still(bot: SVGElement): void {
  clearTimeout(bots.get(bot)?.timer);
  bots.set(bot, {});
  delete bot.dataset.act;
}

export function setMotion(next: boolean): void {
  if (next === on) return;
  on = next;
  for (const bot of bots.keys()) {
    still(bot);
    if (on) rest(bot, true);
  }
}

export function addRobot(bot: SVGElement): () => void {
  bots.set(bot, {});
  if (on) rest(bot, true);
  return () => {
    still(bot);
    bots.delete(bot);
  };
}

const REDUCE = '(prefers-reduced-motion: reduce)';
const watchReduce = (change: () => void) => {
  const q = matchMedia(REDUCE);
  q.addEventListener('change', change);
  return () => q.removeEventListener('change', change);
};

// robots move only on a map in full view: the app active, no character window open, the switch on and motion not reduced
export function useRobotMotion(): void {
  const wanted = useApp((s) => s.active && !s.card && s.settings.robotMotion);
  const reduced = useSyncExternalStore(watchReduce, () => matchMedia(REDUCE).matches);
  const moving = wanted && !reduced;
  useEffect(() => {
    setMotion(moving);
    return () => setMotion(false);
  }, [moving]);
}
