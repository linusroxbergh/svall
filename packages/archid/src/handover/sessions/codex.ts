import fs from 'node:fs';
import path from 'node:path';
import type { ResumeFolder } from '@archipelago/protocol';
import { parse as parseToml } from 'smol-toml';
import { realPath } from '../portable-path.js';
import { compile, inRange, transcriptFile, walkJsonl, type RecordCheck } from './records.js';
import { SessionError, type PathMap, type SessionAdapter, type SessionFs } from './types.js';

const VERSIONS = { min: '0.155.1', max: '0.156.1' };
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const DATED = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];

const TYPES = new Set(['session_meta', 'world_state', 'turn_context', 'response_item', 'event_msg', 'compacted', 'token_usage_record']);

// Prose, tool calls, their output and the rendered world state say what happened on the source; the approved
// command prefixes match exact command text, so one naming a source path simply stops matching
const EVIDENCE = [
  'content', 'text', 'input', 'arguments', 'output', 'stdout', 'stderr', 'aggregated_output', 'formatted_output', 'parsed_cmd',
  'last_agent_message', 'message', 'body', 'filesystem', 'base_instructions', 'instructions', 'approved_command_prefixes',
].map((k) => `**.${k}`);
const COMMON = compile({ evidence: EVIDENCE });
const PERMISSIONS = ['permission_profile.file_system.entries[].path.path', 'file_system_sandbox_policy.entries[].path.path'];
const SPECS: Record<string, ReturnType<typeof compile>> = {
  session_meta: compile({ evidence: EVIDENCE, paths: ['payload.cwd', 'payload.runtime_workspace_roots[]'] }),
  turn_context: compile({ evidence: EVIDENCE, paths: ['payload.cwd', 'payload.workspace_roots[]', ...PERMISSIONS.map((p) => `payload.${p}`)] }),
  world_state: compile({ evidence: EVIDENCE, paths: ['payload.state.environments.environments.*.cwd'] }),
  // a completed item's cwd is a file: URL; the command it ran, the files it changed and the image it viewed are evidence
  'event_msg/item_completed': compile({ evidence: [...EVIDENCE, 'payload.item.command', 'payload.item.changes', 'payload.item.path'], paths: ['payload.item.cwd'] }),
  'event_msg/thread_settings_applied': compile({
    evidence: EVIDENCE,
    paths: ['payload.thread_settings.cwd', 'payload.thread_settings.runtime_workspace_roots[]', ...PERMISSIONS.map((p) => `payload.thread_settings.${p}`)],
  }),
};

function transform(file: string, data: Buffer, map: PathMap): { data: Buffer; issues: string[] } {
  const id = ROLLOUT.exec(path.posix.basename(file))?.[1];
  if (!id) return { data, issues: ['it is not a rollout named for its session'] };
  let first = true;
  const check = (r: Record<string, unknown>): RecordCheck => {
    const opening = first;
    first = false;
    if (typeof r.type !== 'string' || !TYPES.has(r.type)) return { issue: `a ${JSON.stringify(r.type)} record, which Codex ${VERSIONS.min} to ${VERSIONS.max} does not write` };
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    if (opening && r.type !== 'session_meta') return { issue: 'the rollout does not open with its session_meta' };
    if (r.type === 'session_meta') {
      if ((payload.id ?? payload.session_id) !== id) return { issue: `a session_meta that is not session ${id}'s` };
      if (typeof payload.cli_version !== 'string' || !inRange(payload.cli_version, VERSIONS)) {
        return { issue: `written by Codex ${String(payload.cli_version)}, outside ${VERSIONS.min} to ${VERSIONS.max}` };
      }
    }
    return { spec: SPECS[`${r.type}/${String(payload.type)}`] ?? SPECS[r.type] ?? COMMON };
  };
  return walkJsonl(data, map, check);
}

// Codex keys the folders it trusts by real path in config.toml, and trusts a checkout by its repository's main one too
function trusts(home: string, folder: Omit<ResumeFolder, 'kind'>): boolean {
  let projects: unknown;
  try { projects = (parseToml(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')) as { projects?: unknown }).projects; } catch { return false; }
  if (!projects || typeof projects !== 'object') return false;
  const entries = projects as Record<string, { trust_level?: unknown } | undefined>;
  return [folder.cwd, folder.repo].some((p) => p !== undefined && [p, realPath(p)].some((k) => Object.hasOwn(entries, k) && entries[k]?.trust_level === 'trusted'));
}

export const codexAdapter: SessionAdapter = {
  kind: 'codex',
  adapter: 1,
  versions: VERSIONS,
  sessionStartOnResume: false,
  supports: (version) => inRange(version, VERSIONS),

  // <CODEX_HOME>/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl is the whole session: the destination
  // finds it by scanning sessions/ and rebuilds its own thread index from it
  async discover(transcriptPath: string, sessionId: string, fs: SessionFs) {
    const file = path.posix.normalize(transcriptPath);
    if (ROLLOUT.exec(path.posix.basename(file))?.[1] !== sessionId) {
      throw new SessionError('transcript_missing', `${transcriptPath} is not the rollout of session ${sessionId}`);
    }
    const day = path.posix.dirname(file);
    const dated = [path.posix.dirname(path.posix.dirname(day)), path.posix.dirname(day), day];
    const sessions = path.posix.dirname(dated[0]);
    if (!file.startsWith('/') || path.posix.basename(sessions) !== 'sessions' || !dated.every((d, i) => DATED[i].test(path.posix.basename(d)))) {
      throw new SessionError('incompatible_adapter', `${transcriptPath} is not under sessions/<yyyy>/<mm>/<dd> of a Codex home`);
    }
    await transcriptFile(fs, file);
    const home = path.posix.dirname(sessions);
    const transcript = path.posix.relative(home, file);
    return { home, transcript, files: [transcript] };
  },

  carries: (file, transcript, sessionId) =>
    file === transcript && /^sessions\/\d{4}\/\d{2}\/\d{2}\/[^/]+$/.test(file) && ROLLOUT.exec(path.posix.basename(file))?.[1] === sessionId,

  destination: (transcript) => transcript,

  rewrite(file, data, map) {
    const out = transform(file, data, map);
    if (out.issues.length) throw new SessionError('incompatible_adapter', `${file}: ${out.issues.join('; ')}`);
    return out.data;
  },

  validate: (file, data, map) => transform(file, data, map).issues,

  trusts,
};
