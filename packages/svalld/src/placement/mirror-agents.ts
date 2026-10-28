import { frontmatterEnd } from '@svall/protocol';
import { agentServer, fieldPlace, getAt, isDoc, redacted, secretsOf, text, type Place } from './mirror-config.js';

type YamlLine = { indent: number; text: string };
// a YAML map's key, plain or quoted, and what follows its colon
const YAML_KEY = /^([A-Za-z0-9_][\w.-]*|"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*))?$/;
const YAML_ITEM = /^-(?: |$)/;

// a plain or quoted YAML scalar, or a one-line list of them; undefined for any other form
function yamlScalar(v: string): unknown {
  if (v.startsWith('"')) {
    try { return text(JSON.parse(v)); } catch { return undefined; }
  }
  if (v.startsWith("'")) return /^'(?:[^']|'')*'$/.test(v) ? v.slice(1, -1).replaceAll("''", "'") : undefined;
  if (v.startsWith('[') && v.endsWith(']')) {
    const items = v.slice(1, -1).split(',').map((x) => x.trim());
    const list = (items.at(-1) === '' ? items.slice(0, -1) : items).map(yamlScalar);
    return list.every((x) => typeof x === 'string') ? list : undefined;
  }
  const special = /^[,[\]{}#&*!|>'"%@`]/.test(v) || /^[-?:](\s|$)/.test(v);
  return v === '' || special || /: | #|:$/.test(v) ? undefined : v;
}

// the value under a line at `indent`: the block indented past it, or null where there is none
const yamlUnder = (lines: YamlLine[], i: number, indent: number): [unknown, number] | undefined =>
  (lines[i] !== undefined && lines[i].indent > indent ? yamlBlock(lines, i, lines[i].indent) : [null, i]);

// the YAML map or list in `lines` from `i` at `indent`, and the index past it; undefined for a form the mirror does not read
function yamlBlock(lines: YamlLine[], i: number, indent: number): [unknown, number] | undefined {
  const list = YAML_ITEM.test(lines[i].text);
  const out: unknown[] | Record<string, unknown> = list ? [] : {};
  while (lines[i]?.indent === indent && YAML_ITEM.test(lines[i].text) === list) {
    const line = lines[i].text;
    let v: [unknown, number] | undefined;
    if (Array.isArray(out)) {
      const rest = line.slice(1).trimStart();
      const at = indent + line.length - rest.length;
      if (rest === '') v = yamlUnder(lines, i + 1, indent);
      else if (YAML_KEY.test(rest)) {
        // a map that starts on its item's line
        lines[i] = { indent: at, text: rest };
        v = yamlBlock(lines, i, at);
      } else v = [yamlScalar(rest), i + 1];
      if (v?.[0] === undefined) return undefined;
      out.push(v[0]);
    } else {
      const kv = YAML_KEY.exec(line);
      const key = kv && yamlScalar(kv[1]);
      if (typeof key !== 'string' || Object.hasOwn(out, key)) return undefined;
      // a key's list may stand at the key's own indent
      const own = lines[i + 1]?.indent === indent && YAML_ITEM.test(lines[i + 1].text);
      v = kv?.[2] ? [yamlScalar(kv[2]), i + 1] : own ? yamlBlock(lines, i + 1, indent) : yamlUnder(lines, i + 1, indent);
      if (v?.[0] === undefined) return undefined;
      out[key] = v[0];
    }
    i = v[1];
  }
  return [out, i];
}

// a subagent frontmatter's mcpServers block and its lines; null for none, undefined where it is not plain YAML or JSON or a
// YAML reader could take mcpServers from elsewhere too, as a quoted, escaped, explicit or second key
function agentBlock(source: string): { value: unknown; from: number; count: number } | null | undefined {
  const end = frontmatterEnd(source);
  const lines = end ? source.slice(0, end).split(/\r?\n/).slice(1, -1) : [];
  const at = lines.findIndex((l) => /^mcpServers\s*:/.test(l));
  const after = at < 0 ? [] : lines.slice(at + 1);
  // the next key at the top ends the block
  const stop = after.findIndex((l) => /^[^\s#-]|^-\S/.test(l));
  const count = at < 0 ? 0 : 1 + (stop < 0 ? after.length : stop);
  // a key with an escape in it, or an explicit `?` one, at any indent may read as mcpServers too, as may a flow mapping
  const names = (l: string): boolean => l.includes('mcpServers') || /^\?(\s|$)/.test(l.trimStart()) || /^"[^"]*\\/.test(YAML_KEY.exec(l.trimStart())?.[1] ?? '');
  const first = lines.find((l) => !/^\s*(#|$)/.test(l));
  if (first?.trimStart().startsWith('{') || lines.some((l, i) => (i < at || i >= at + count) && names(l))) return undefined;
  if (at < 0) return null;
  const head = lines[at].slice(lines[at].indexOf(':') + 1).trim();
  const body: YamlLine[] = [];
  for (const l of after.slice(0, count - 1)) {
    if (/^\s*(#|$)/.test(l)) continue;
    if (/^ *\t/.test(l)) return undefined;
    body.push({ indent: l.length - l.trimStart().length, text: l.trim() });
  }
  if (head !== '' && body.length) return undefined;
  const block = head === '' && body.length ? yamlBlock(body, 0, body[0].indent) : [null, 0];
  if (!block || block[1] !== body.length) return undefined;
  let value: unknown = block[0];
  if (head !== '') {
    try { value = JSON.parse(head); } catch { value = yamlScalar(head); }
  }
  return value === undefined ? undefined : { value, from: at + 1, count };
}

// the servers a subagent's mcpServers map or list defines inline; undefined for another shape
function inlineServers(value: unknown): { place: Place; name: string; raw: unknown }[] | undefined {
  if (value === null) return [];
  if (isDoc(value)) return Object.entries(value).map(([name, raw]) => ({ place: [name], name, raw }));
  if (!Array.isArray(value)) return undefined;
  const servers: { place: Place; name: string; raw: unknown }[] = [];
  for (const [i, e] of value.entries()) {
    if (typeof e === 'string') continue;
    if (!isDoc(e) || Object.keys(e).length !== 1) return undefined;
    const [name, raw] = Object.entries(e)[0];
    servers.push({ place: [i, name], name, raw });
  }
  return servers;
}

/** The servers a subagent file's `mcpServers` defines inline, not those it only names; undefined where it cannot be read. */
export function agentServers(source: string): [name: string, entry: unknown][] | undefined {
  const b = agentBlock(source);
  if (b === null) return [];
  return b && inlineServers(b.value)?.map((s) => [s.name, s.raw]);
}

/**
 * What the mirror asks of a subagent file before it travels: each inline server holding a key or unknown fields, as
 * `mcpServers.<name>`, or `mcpServers` whole where it cannot read them.
 */
export function agentKeys(source: string): string[] {
  const servers = agentServers(source);
  if (!servers) return ['mcpServers'];
  return [...new Set(servers.filter(([name, raw]) => {
    if (!isDoc(raw)) return true;
    const s = agentServer(name, raw);
    return !s.known || secretsOf(s).length > 0;
  }).map(([name]) => `mcpServers.${name}`))];
}

/**
 * Each key of a subagent file's inline servers by its place in mcpServers, with its value and what an untick leaves there;
 * undefined where a server's fields are not all known or the block cannot be read.
 */
export function agentLeaves(source: string): { place: Place; value: string; bare: string }[] | undefined {
  const b = agentBlock(source);
  const servers = b === null ? [] : b && inlineServers(b.value);
  if (!servers) return undefined;
  const leaves = new Map<string, { place: Place; value: string; bare: string }>();
  for (const { place, name, raw } of servers) {
    if (!isDoc(raw)) return undefined;
    const s = agentServer(name, raw);
    if (!s.known) return undefined;
    const bare = redacted(s, new Set());
    for (const leaf of secretsOf(s).flatMap((f) => fieldPlace('claude', raw, f.field))) {
      leaves.set(JSON.stringify([...place, ...leaf]), { place: [...place, ...leaf], value: getAt(raw, leaf) as string, bare: getAt(bare, leaf) as string });
    }
  }
  return [...leaves.values()];
}

/** The mcpServers value of subagent file `source`, and the file with that value written in place of its block, on one line. */
export function agentDoc(source: string): { value: unknown; write: (value: unknown) => string } | undefined {
  const b = agentBlock(source);
  if (!b) return undefined;
  const end = frontmatterEnd(source);
  return {
    value: b.value,
    write: (value) => {
      const lines = source.slice(0, end).split(/\r?\n/);
      lines.splice(b.from, b.count, `mcpServers: ${JSON.stringify(value)}`);
      return `${lines.join(source.includes('\r\n') ? '\r\n' : '\n')}${source.slice(end)}`;
    },
  };
}
