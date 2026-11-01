// Each robot rests, then plays one action from its own list (data-idle or data-work, by its card's state; an idle one
// plays each data-rare action at RARE odds instead); an action is the CSS animations its SVG keys on data-act, and it
// ends when they all finish. As on the map, rests and action lengths vary up to a tenth either way
const REST = { idle: 3500, working: 1800 };
const RARE = 0.005;
const jitter = () => 0.9 + Math.random() * 0.2;
const list = (s) => (s || '').split(' ').filter(Boolean);
const any = (acts) => acts[Math.floor(Math.random() * acts.length)];
const pick = (bot, working) => {
  if (working) return any(list(bot.dataset.work));
  const rare = list(bot.dataset.rare), roll = Math.random();
  return roll < RARE * rare.length ? rare[Math.floor(roll / RARE)] : any(list(bot.dataset.idle));
};
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
    const act = pick(bot, working);
    if (act && !bot.dataset.act) await play(bot, act);
    cycle(bot);
  }, centre * (first ? Math.random() : jitter())));
}

// after REST changes, robots waiting out an old rest start a new one
function retime() {
  for (const [bot, t] of waiting) { clearTimeout(t); cycle(bot, true); }
}

window.motion = { REST, play, retime, start: (bot) => cycle(bot, true) };
