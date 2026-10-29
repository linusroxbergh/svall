import { inSpan, outliner, type Outline, type Span } from '../retro/outline.js';

type Texts = { text?: string }[];
type Part = {
  type?: string; text?: string; name?: string; time?: { created?: number };
  state?: {
    status?: string; input?: { id?: unknown; command?: unknown; path?: unknown; filePath?: unknown; patchText?: unknown }; content?: Texts;
    metadata?: { exit?: number; name?: unknown }; error?: { type?: string; message?: string };
  };
};
type Message = {
  type?: string; time?: { created?: number }; text?: string; outcome?: string;
  cost?: number; model?: { id?: string; providerID?: string }; content?: Part[];
};
type Export = { info?: { id?: string; location?: { directory?: string } }; messages?: Message[] };

const SHELLS = new Set(['shell', 'bash']);
const WRITES = new Set(['write', 'edit', 'multiedit', 'patch', 'apply_patch']);
const PATCHED = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const DECLINED = 'The user declined';

const texts = (c?: Texts): string => (c ?? []).map((x) => x.text ?? '').join('').trim();

/** `exported` is what `opencode session export` prints; a line is a message's place in its list. */
export function outlineOpencode(exported: unknown, span: Span): Outline {
  const { info, messages = [] } = (exported ?? {}) as Export;
  const out = outliner();
  const dir = info?.location?.directory;
  let model: string | undefined;
  let cost = 0;
  messages.forEach((m, i) => {
    const n = i + 1;
    const at = m.time?.created ?? NaN;
    if (!inSpan(at, span)) return;
    if (m.type === 'user' && m.text?.trim()) out.prompt(n, at, m.text.trim());
    if (m.type === 'idle' && m.outcome === 'interrupted') out.interrupt(n, at);
    if (m.type !== 'assistant') return;
    cost += m.cost ?? 0;
    if (m.model?.id) model = m.model.providerID ? `${m.model.providerID}/${m.model.id}` : m.model.id;
    (m.content ?? []).forEach((c, i) => {
      const t = c.time?.created ?? at;
      if (c.type === 'text' && c.text?.trim()) out.said(n, t, c.text.trim(), i);
      if (c.type !== 'tool') return;
      const name = c.name ?? 'tool';
      const s = c.state ?? {};
      const call = out.tool(n, t, name, s.input, i);
      if (s.error?.type === 'aborted' && s.error.message?.startsWith(DECLINED)) {
        out.rejected(n, t, name, i);
        return;
      }
      const skill = s.input?.id ?? s.metadata?.name;
      if (name === 'skill' && typeof skill === 'string') out.skill(skill, n, t, { id: call.id });
      const exit = s.metadata?.exit;
      const failed = s.status === 'error' || (typeof exit === 'number' && exit !== 0);
      const said = s.error?.message ?? texts(s.content);
      if (SHELLS.has(name) && typeof s.input?.command === 'string') {
        out.ran(call, n, t, s.input.command, { failed, ...(typeof exit === 'number' && { exit }), out: said }, i);
        out.ranIn(s.input.command, dir);
      } else if (failed) out.error(n, t, said, i);
      if (!WRITES.has(name)) return;
      const file = s.input?.path ?? s.input?.filePath;
      if (typeof file === 'string') out.wrote(file, dir);
      if (typeof s.input?.patchText === 'string') for (const [, f] of s.input.patchText.matchAll(PATCHED)) out.wrote(f, dir);
    });
  });
  return out.outline({ agent: 'opencode', session: info?.id ?? '', file: '', model, cwd: dir, costUsd: cost });
}
