// a control byte would reach the agent as a key typed past the paste's end, as Esc [201~ ends a bracketed paste
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
// a name on one line and short enough that the header outlives the 2000-character clip of a prompt read back
const NAME_MAX = 200;

/** `text` as robot `from`'s message, after a line naming the sender and how to answer it. */
export const robotMessage = (from: { name: string; id: string }, text: string): string => {
  const name = from.name.replace(/\s+/g, ' ').replace(CONTROL, '').slice(0, NAME_MAX);
  return `[from robot ${name} (${from.id}); reply with svall robot send ${from.id}]\n${text.replace(/\r\n?/g, '\n').replace(CONTROL, '')}`;
};

// the header on the prompt's first line; Claude Code keeps a paste it shows collapsed inside <pasted_content id="…">
const HEADER = /^\s*(?:<pasted_content id="[^"]*">\n)?\[from robot [^\n]* \((c_[a-z0-9]{6})\); reply with svall robot send \1\](?:\n|$)/;

/** The id of the robot whose message `prompt` is, as an agent's transcript holds it; undefined for anyone else's. */
export const robotSender = (prompt: string): string | undefined => HEADER.exec(prompt)?.[1];
