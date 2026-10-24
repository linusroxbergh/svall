// Each robot rests, then plays one action from its own list (data-idle or data-work, by its card's state);
// an action is the CSS animations its SVG keys on data-act, and it ends when they all finish. As on the map, rests
// and action lengths vary up to a tenth either way
const REST = { idle: 3500, working: 2000 };
const jitter = () => 0.9 + Math.random() * 0.2;
const waiting = new Map();

async function play(bot, act) {
  bot.dataset.act = act;
  const parts = bot.getAnimations({ subtree: true });
  // one rate for every part, so they stay in step
  const rate = 1 / jitter();
  for (const a of parts) a.playbackRate = rate;
  await Promise.all(parts.map((a) => a.finished.catch(() => {})));
  if (bot.dataset.act === act) delete bot.dataset.act;
}

function cycle(bot, first) {
  const working = !!bot.closest('.working');
  const centre = REST[working ? 'working' : 'idle'];
  waiting.set(bot, setTimeout(async () => {
    waiting.delete(bot);
    const acts = ((working ? bot.dataset.work : bot.dataset.idle) || '').split(' ').filter(Boolean);
    if (acts.length && !bot.dataset.act) await play(bot, acts[Math.floor(Math.random() * acts.length)]);
    cycle(bot);
  }, centre * (first ? Math.random() : jitter())));
}

// after REST changes, robots waiting out an old rest start a new one
function retime() {
  for (const [bot, t] of waiting) { clearTimeout(t); cycle(bot, true); }
}

window.motion = { REST, play, retime, start: (bot) => cycle(bot, true) };
