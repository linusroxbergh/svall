// Readers of vendor source text: each returns the names a declaration holds, or undefined when the declaration is gone

// the text between the `{` that opens the declaration at `from` and its matching `}`; a declaration that ends at a `;`
// before any `{` has no body
function body(src: string, from: number): string | undefined {
  const open = src.indexOf('{', from);
  const semi = src.indexOf(';', from);
  if (open < 0 || (semi >= 0 && semi < open)) return undefined;
  for (let i = open, depth = 0; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return undefined;
}

// the lines that start at the body's own level, not inside a nested `{}`
function topLines(text: string): string[] {
  const lines: string[] = [];
  let depth = 0;
  for (const line of text.split('\n')) {
    if (depth === 0) lines.push(line);
    for (const c of line) depth += c === '{' ? 1 : c === '}' ? -1 : 0;
  }
  return lines;
}

/** Property names of `export declare type <name> = … { … }` in a .d.ts. */
export function tsTypeProps(src: string, name: string): string[] | undefined {
  const at = src.indexOf(`export declare type ${name} =`);
  const text = at < 0 ? undefined : body(src, at);
  return text === undefined ? undefined : topLines(text).flatMap((l) => /^\s*(?:readonly\s+)?(\w+)\??\s*:/.exec(l)?.[1] ?? []);
}

/** The strings of `declare const <name>: readonly [...]` in a .d.ts. */
export function tsConstStrings(src: string, name: string): string[] | undefined {
  const m = new RegExp(`declare const ${name}: readonly \\[([^\\]]*)\\]`).exec(src);
  return m ? Array.from(m[1].matchAll(/'([^']+)'/g), (x) => x[1]) : undefined;
}

const rustItem = (kind: 'enum' | 'struct', name: string) => new RegExp(`^[ \\t]*(?:pub(?:\\([^)]*\\))?\\s+)?${kind}\\s+${name}\\b`, 'm');
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
// a Rust name (a PascalCase variant or a snake_case field) as serde writes it under `rename_all`
function serdeName(name: string, rule: string | undefined): string {
  const w = (/^[A-Z]/.test(name) ? name.split(/(?=[A-Z])/) : name.split('_')).map((x) => x.toLowerCase());
  switch (rule) {
    case 'snake_case': return w.join('_');
    case 'camelCase': return w[0] + w.slice(1).map(cap).join('');
    case 'PascalCase': return w.map(cap).join('');
    case 'kebab-case': return w.join('-');
    case 'SCREAMING_SNAKE_CASE': return w.join('_').toUpperCase();
    case 'lowercase': return w.join('');
    case 'UPPERCASE': return w.join('').toUpperCase();
    default: return name;
  }
}

// the attribute and comment lines straight above the line at `at`
function attrsAbove(src: string, at: number): string {
  const lines = src.slice(0, src.lastIndexOf('\n', at) + 1).split('\n').slice(0, -1);
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && /^\s*(#\[|\/\/)/.test(lines[i]); i--) out.push(lines[i]);
  return out.join('\n');
}

// the names serde writes for a Rust enum's variants or a struct's fields: skipped ones left out, `rename_all` and
// `rename` applied
function serdeMembers(src: string, kind: 'enum' | 'struct', name: string, member: RegExp): string[] | undefined {
  const m = rustItem(kind, name).exec(src);
  const text = m ? body(src, m.index) : undefined;
  if (!m || text === undefined) return undefined;
  const rule = /rename_all\s*=\s*"([^"]+)"/.exec(attrsAbove(src, m.index))?.[1];
  const names: string[] = [];
  let rename: string | undefined;
  let skip = false;
  for (const line of topLines(text)) {
    if (/^\s*#\[serde\(/.test(line)) {
      rename = /\brename\s*=\s*"([^"]+)"/.exec(line)?.[1] ?? rename;
      // skip_serializing_if and skip_deserializing still write the member
      skip ||= /\bskip(?:_serializing)?\b/.test(line);
      continue;
    }
    const v = member.exec(line);
    if (!v) continue;
    if (!skip) names.push(rename ?? serdeName(v[1], rule));
    rename = undefined;
    skip = false;
  }
  return names;
}

/** The tags a Rust enum's variants serialize to. */
export const rustEnumTags = (src: string, name: string): string[] | undefined => serdeMembers(src, 'enum', name, /^\s*([A-Z]\w*)\b/);

/** The names a Rust struct's named fields serialize to. */
export const rustStructFields = (src: string, name: string): string[] | undefined =>
  serdeMembers(src, 'struct', name, /^\s*(?:pub(?:\([^)]*\))?\s+)?([a-z_]\w*)\s*:/);

/** Every `type: "a.b"` event name in OpenCode's schema source. */
export const quotedTypes = (src: string): string[] => [...new Set(Array.from(src.matchAll(/\btype:\s*"([a-z][\w.]*)"/g), (m) => m[1]))];

/** Whether TypeScript source declares a property `key`. */
export const hasKey = (src: string, key: string): boolean => new RegExp(`\\b${key}\\??\\s*:`).test(src);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether a CLI's help lists a flag or subcommand as an entry of its own (`--model <m>`, `-s, --session`, `--session, -s`, `resume  Resume
 * a session`), indented 2 to 6 spaces; a mention in another entry's description, indented further, doesn't count. */
export const helpHas = (help: string, word: string): boolean => new RegExp(`^ {2,6}(?:-{1,2}[\\w-]+, +)*${escape(word)}(?=[\\s,=<\\[]|$)`, 'm').test(help);

/** The highest plain x.y.z among names like `v2.0.9` or `refs/tags/v2.0.10`; pre-releases are left out. */
export function newest(names: string[]): string | undefined {
  const vs = names.flatMap((n) => {
    const m = /^\D*(\d+)\.(\d+)\.(\d+)$/.exec(n);
    return m ? [[Number(m[1]), Number(m[2]), Number(m[3])]] : [];
  });
  vs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return vs.at(-1)?.join('.');
}
