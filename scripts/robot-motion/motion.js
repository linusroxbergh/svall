// Each robot rests, then plays one action from its own list (data-idle or data-work, by its card's state);
// an action is the CSS animations its SVG keys on data-act, and it ends when they all finish.
const REST = { idle: [2000, 5000], working: [1000, 3000] };
const waiting = new Map();

async function play(bot, act) {
  bot.dataset.act = act;
  await Promise.all(bot.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
  if (bot.dataset.act === act) delete bot.dataset.act;
}

function cycle(bot, first) {
  const working = !!bot.closest('.working');
  const [lo, hi] = REST[working ? 'working' : 'idle'];
  waiting.set(bot, setTimeout(async () => {
    waiting.delete(bot);
    const acts = ((working ? bot.dataset.work : bot.dataset.idle) || '').split(' ').filter(Boolean);
    if (acts.length && !bot.dataset.act) await play(bot, acts[Math.floor(Math.random() * acts.length)]);
    cycle(bot);
  }, first ? Math.random() * hi : lo + Math.random() * (hi - lo)));
}

// after REST changes, robots waiting out an old rest start a new one
function retime() {
  for (const [bot, t] of waiting) { clearTimeout(t); cycle(bot, true); }
}

window.motion = { REST, play, retime, start: (bot) => cycle(bot, true) };
