import path from 'node:path';

// find is the text the editor puts the cursor on; path is where a plugin is installed
export type Parsed = { name: string; detail?: string; off?: true; find?: string; path?: string };

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

// the first word of a command is the program; what follows may carry a token
const whereOf = (s: Record<string, unknown>): string | undefined => {
  if (typeof s.url === 'string') { try { return new URL(s.url).host; } catch { return undefined; } }
  return typeof s.command === 'string' ? path.basename(s.command.trim().split(/\s+/)[0]) : undefined;
};

/** Name, transport and program or host; nothing else in a server's entry is safe to show. */
export function mcpServers(servers: unknown): Parsed[] {
  return Object.entries(obj(servers) ?? {}).map(([name, raw]) => {
    const s = obj(raw) ?? {};
    const transport = typeof s.type === 'string' ? s.type : typeof s.url === 'string' ? 'http' : 'stdio';
    return { name, detail: [transport, whereOf(s)].filter(Boolean).join(' · '), find: JSON.stringify(name) };
  });
}

export function hooks(h: unknown): Parsed[] {
  return Object.entries(obj(h) ?? {}).flatMap(([name, matchers]) => {
    const n = (Array.isArray(matchers) ? matchers : []).reduce((sum, m) => { const hs = obj(m)?.hooks; return sum + (Array.isArray(hs) ? hs.length : 0); }, 0);
    return n ? [{ name, detail: `${n} command${n === 1 ? '' : 's'}`, find: JSON.stringify(name) }] : [];
  });
}

/** `installed` is installed_plugins.json's `plugins`, `enabled` is settings.json's `enabledPlugins`. */
export function plugins(installed: unknown, enabled: unknown): Parsed[] {
  const on = obj(enabled) ?? {};
  return Object.entries(obj(installed) ?? {}).map(([key, installs]) => {
    const at = key.lastIndexOf('@');
    const first = Array.isArray(installs) ? obj(installs[0]) : undefined;
    return {
      name: at > 0 ? key.slice(0, at) : key,
      ...(at > 0 && { detail: key.slice(at + 1) }),
      ...(on[key] !== true && { off: true as const }),
      find: JSON.stringify(key),
      ...(typeof first?.installPath === 'string' && { path: first.installPath }),
    };
  });
}
