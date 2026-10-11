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
const snake = (s: string) => s.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();

// the attribute and comment lines straight above the line at `at`
function attrsAbove(src: string, at: number): string {
  const lines = src.slice(0, src.lastIndexOf('\n', at) + 1).split('\n').slice(0, -1);
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && /^\s*(#\[|\/\/)/.test(lines[i]); i--) out.push(lines[i]);
  return out.join('\n');
}

/** The tags a Rust enum's variants serialize to, after serde's `rename_all = "snake_case"` and per-variant `rename`. */
export function rustEnumTags(src: string, name: string): string[] | undefined {
  const m = rustItem('enum', name).exec(src);
  const text = m ? body(src, m.index) : undefined;
  if (!m || text === undefined) return undefined;
  const snakeCase = /rename_all\s*=\s*"snake_case"/.test(attrsAbove(src, m.index));
  const tags: string[] = [];
  let rename: string | undefined;
  for (const line of topLines(text)) {
    const r = /#\[serde\(.*\brename\s*=\s*"([^"]+)"/.exec(line);
    if (r) { rename = r[1]; continue; }
    const v = /^\s*([A-Z]\w*)\b/.exec(line);
    if (!v) continue;
    tags.push(rename ?? (snakeCase ? snake(v[1]) : v[1]));
    rename = undefined;
  }
  return tags;
}

/** Field names of a Rust struct with named fields. */
export function rustStructFields(src: string, name: string): string[] | undefined {
  const m = rustItem('struct', name).exec(src);
  const text = m ? body(src, m.index) : undefined;
  return text === undefined ? undefined : topLines(text).flatMap((l) => /^\s*(?:pub(?:\([^)]*\))?\s+)?([a-z_]\w*)\s*:/.exec(l)?.[1] ?? []);
}

/** Every `type: "a.b"` event name in OpenCode's schema source. */
export const quotedTypes = (src: string): string[] => [...new Set(Array.from(src.matchAll(/\btype:\s*"([a-z][\w.]*)"/g), (m) => m[1]))];

/** Whether TypeScript source declares a property `key`. */
export const hasKey = (src: string, key: string): boolean => new RegExp(`\\b${key}\\??\\s*:`).test(src);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether a CLI's help lists a flag or subcommand: `--model <m>`, `-s, --session`, `resume  Resume a session`. */
export const helpHas = (help: string, word: string): boolean => new RegExp(`(^|[\\s,])${escape(word)}(?=[\\s,=<\\[]|$)`, 'm').test(help);

/** The highest plain x.y.z among names like `v2.0.9` or `refs/tags/v2.0.10`; pre-releases are left out. */
export function newest(names: string[]): string | undefined {
  const vs = names.flatMap((n) => {
    const m = /^\D*(\d+)\.(\d+)\.(\d+)$/.exec(n);
    return m ? [[Number(m[1]), Number(m[2]), Number(m[3])]] : [];
  });
  vs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return vs.at(-1)?.join('.');
}
