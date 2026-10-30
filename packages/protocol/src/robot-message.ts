/** `text` as robot `from`'s message, after a line naming the sender and how to answer it. */
export const robotMessage = (from: { name: string; id: string }, text: string): string =>
  `[from robot ${from.name} (${from.id}); reply with svall robot send ${from.id}]\n${text}`;

// the header on the prompt's first line; Claude Code keeps a paste it shows collapsed inside <pasted_content id="…">
const HEADER = /^\s*(?:<pasted_content id="[^"]*">\n)?\[from robot [^\n]* \((c_[a-z0-9]{6})\); reply with svall robot send \1\](?:\n|$)/;

/** The id of the robot whose message `prompt` is, as an agent's transcript holds it; undefined for anyone else's. */
export const robotSender = (prompt: string): string | undefined => HEADER.exec(prompt)?.[1];
