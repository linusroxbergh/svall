import type { Agent, FleetState, Robot } from './state.js';

// a control byte would reach the agent as a key typed past the paste's end, as Esc [201~ ends a bracketed paste
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
// a name on one line and short enough that the header outlives the 2000-character clip of a prompt read back
const NAME_MAX = 200;
const oneLine = (s: string, max = Infinity) => s.replace(/\s+/g, ' ').replace(CONTROL, '').slice(0, max);

/** `text` as robot `from`'s message, after a line naming the sender and how to answer it. */
export const robotMessage = (from: { name: string; id: string }, text: string): string =>
  `[from robot ${oneLine(from.name, NAME_MAX)} (${from.id}); reply with svall robot send ${from.id}]\n${text.replace(/\r\n?/g, '\n').replace(CONTROL, '')}`;

// Claude Code keeps a paste it shows collapsed inside <pasted_content id="…">
const WRAPPED = String.raw`^\s*(?:<pasted_content id="[^"]*">\n)?`;
// the header on the prompt's first line
const HEADER = new RegExp(String.raw`${WRAPPED}\[from robot [^\n]* \((c_[a-z0-9]{6})\); reply with svall robot send \1\](?:\n|$)`);
const NOTICE = new RegExp(String.raw`${WRAPPED}\[svall\] [^\n]* \(c_[a-z0-9]{6}\) `);

/** The id of the robot whose message `prompt` is, as an agent's transcript holds it; undefined for anyone else's. */
export const robotSender = (prompt: string): string | undefined => HEADER.exec(prompt)?.[1];

/** svalld's line about robot `c`, one line whatever `rest` holds. */
export const robotNotice = (c: { name: string; id: string }, rest: string): string => `[svall] ${oneLine(c.name, NAME_MAX)} (${c.id}) ${oneLine(rest)}`;

/** Whether a robot or svalld typed `prompt`, rather than the user. */
export const isRobotSaid = (prompt: string): boolean => HEADER.test(prompt) || NOTICE.test(prompt);

/** The robot messages one robot takes with no prompt of the user's between them, past which the next waits on the user. */
export const RELAY_LIMIT = 200;

// text as a hook hands a prompt on, control bytes and whitespace aside
const plain = (s: string) => s.replace(CONTROL, '').replace(/\s+/g, ' ').trim();

/** The head of a request's text, which a report on it knows the request by. */
export const says = (text: string): string => plain(text).slice(0, 80);

/** Whether `text` is the request a report knows by its head. */
export const saysIn = (r: { says?: string }, text: string): boolean => !r.says || plain(text).includes(r.says);

/** Whether `c`'s newest prompt is the request a report is owed on; Claude Code takes a prompt sent mid-turn into that turn,
 *  under the turn's id with the new prompt's text. */
export const reportBegan = (c: Robot): boolean => {
  const r = c.report;
  const p = c.agent?.lastPrompt;
  // a robot's message or svalld's line taken into the turn leaves it the request's
  if (!r || !p || (!saysIn(r, p.text) && !(r.prompt && isRobotSaid(p.text)))) return false;
  if (r.prompt) return p.id === r.prompt;
  return p.id !== r.after && (!r.tagged || robotSender(p.text) === r.to);
};

/** The robot a report on `c`'s request goes to, while it is owed and that robot has an agent, live or dormant, to take it. */
export const owedTo = (f: Pick<FleetState, 'robots'>, c: Robot): Robot | undefined => {
  const to = c.report && reportBegan(c) && Object.hasOwn(f.robots, c.report.to) ? f.robots[c.report.to] : undefined;
  return to?.agent ? to : undefined;
};

/** The agent a robot's main terminal shows: one whose robot messages wait on the user asks the user, unless its agent asks first. */
export const shownAgent = (c: Robot): Agent | undefined => {
  if (!c.relayed?.held || !c.agent || c.agent.status === 'blocked') return c.agent;
  const { askedTool: _, ...agent } = c.agent;
  return { ...agent, status: 'blocked', prompt: `${c.relayed.n} robot messages since your last prompt; let robots carry on?`, promptId: c.relayed.held };
};
