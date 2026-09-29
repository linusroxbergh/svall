#!/usr/bin/env node
// An M0 spike probe (docs/fleet-handover/spike-results.md). Manual: running it by hand on a rollout a real Codex wrote.
// The svalld suite runs it on the fixture rollouts in packages/svalld/test/handover/codex-portability.test.ts.

// A disposable-session probe, not the production transfer adapter. Never copies auth/config files.
// The session_index.jsonl branch is defensive: `codex exec` was not seen to write that file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f-]{36})\.jsonl$/i;
const METADATA_PATH_KEYS = new Set(['cwd', 'workspace_roots', 'runtime_workspace_roots']);
// Prose, tool arguments and tool output say what happened on the source machine; the rendered
// world-state blobs and the approved-command allowlist are reissued or re-matched by the next turn.
const EVIDENCE_KEYS = new Set(['content', 'text', 'input', 'arguments', 'output', 'stdout', 'stderr',
  'aggregated_output', 'formatted_output', 'parsed_cmd', 'last_agent_message', 'message', 'body',
  'filesystem', 'base_instructions', 'instructions', 'approved_command_prefixes']);

function within(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

// a completed command's cwd is written as a file:// URI, everything else as a bare path
function rewritePath(value, mappings) {
  if (typeof value !== 'string') return value;
  const scheme = value.startsWith('file://') ? 'file://' : '';
  const location = value.slice(scheme.length);
  if (!path.isAbsolute(location)) return value;
  for (const [from, to] of mappings) {
    if (within(location, from)) return `${scheme}${to}${location.slice(from.length)}`;
  }
  return value;
}

const rewritePaths = (value, mappings) => (Array.isArray(value)
  ? value.map((item) => rewritePath(item, mappings)) : rewritePath(value, mappings));

export function relocateMetadata(value, mappings, parentKey = '') {
  if (Array.isArray(value)) return value.map((item) => relocateMetadata(item, mappings, parentKey));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (EVIDENCE_KEYS.has(key)) result[key] = item;
    // a sandbox entry names its directory as { path: { type: 'path', path } }
    else if (METADATA_PATH_KEYS.has(key) || (key === 'path' && parentKey === 'path')) {
      result[key] = rewritePaths(item, mappings);
    } else result[key] = relocateMetadata(item, mappings, key);
  }
  return result;
}

function rewriteJsonl(source, destination, mappings) {
  const lines = fs.readFileSync(source, 'utf8').split('\n');
  const rewritten = lines.map((line) => (line ? JSON.stringify(relocateMetadata(JSON.parse(line), mappings)) : line));
  fs.writeFileSync(destination, rewritten.join('\n'), { flag: 'wx', mode: 0o600 });
}

export function discoverSession(rolloutPath) {
  const sourceRollout = path.resolve(rolloutPath);
  const named = ROLLOUT.exec(path.basename(sourceRollout));
  if (!named || !SESSION_ID.test(named[1]))
    throw new Error('Expected a Codex rollout named rollout-<timestamp>-<uuid>.jsonl');
  if (fs.lstatSync(sourceRollout).isSymbolicLink()) throw new Error(`Refusing rollout symlink: ${sourceRollout}`);
  if (!fs.statSync(sourceRollout).isFile()) throw new Error('Rollout is not a file');
  const day = path.dirname(sourceRollout);
  const month = path.dirname(day);
  const year = path.dirname(month);
  const sessions = path.dirname(year);
  const dated = [year, month, day].map((dir) => path.basename(dir));
  if (path.basename(sessions) !== 'sessions' || !/^\d{4}$/.test(dated[0]) ||
    !/^\d{2}$/.test(dated[1]) || !/^\d{2}$/.test(dated[2]))
    throw new Error('Rollout is not under sessions/<yyyy>/<mm>/<dd> of a CODEX_HOME');
  const sessionId = named[1].toLowerCase();
  const head = fs.readFileSync(sourceRollout, 'utf8').split('\n', 1)[0];
  const meta = head.startsWith('{') ? JSON.parse(head) : {};
  if (meta.type !== 'session_meta') throw new Error('Rollout does not open with a session_meta line');
  // 0.142 writes only `id`; 0.155 writes both
  const metaId = meta.payload?.session_id ?? meta.payload?.id;
  if (String(metaId).toLowerCase() !== sessionId)
    throw new Error('Rollout filename and session_meta id disagree');
  return { sessionId, sourceRollout, codexHome: path.dirname(sessions),
    datePath: path.join('sessions', ...dated) };
}

export function copySession({ rolloutPath, sourceCwd, destinationCwd, destinationCodexHome }) {
  const source = discoverSession(rolloutPath);
  if (!path.isAbsolute(sourceCwd) || !path.isAbsolute(destinationCwd) || !path.isAbsolute(destinationCodexHome))
    throw new Error('All cwd and home paths must be absolute');
  const mappings = [[path.resolve(sourceCwd), path.resolve(destinationCwd)]];
  const destinationDir = path.join(path.resolve(destinationCodexHome), source.datePath);
  const destinationRollout = path.join(destinationDir, path.basename(source.sourceRollout));
  if (fs.existsSync(destinationRollout)) throw new Error(`Destination rollout already exists: ${destinationRollout}`);
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  const files = [destinationRollout];
  rewriteJsonl(source.sourceRollout, destinationRollout, mappings);
  // The rollout is enough to resume; the sqlite thread index is rebuilt from it. history.jsonl holds
  // every session's prompts, so only this session's index entry, which names no path, moves with it.
  const indexPath = path.join(source.codexHome, 'session_index.jsonl');
  if (fs.existsSync(indexPath)) {
    const entries = fs.readFileSync(indexPath, 'utf8').split('\n')
      .filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
      .filter((entry) => String(entry.id).toLowerCase() === source.sessionId);
    if (entries.length) {
      const destinationIndex = path.join(path.resolve(destinationCodexHome), 'session_index.jsonl');
      if (fs.existsSync(destinationIndex)) throw new Error(`Destination index already exists: ${destinationIndex}`);
      fs.writeFileSync(destinationIndex, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
        { flag: 'wx', mode: 0o600 });
      files.push(destinationIndex);
    }
  }
  return { sessionId: source.sessionId, destinationRollout, files };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rolloutPath, sourceCwd, destinationCwd, destinationCodexHome] = process.argv.slice(2);
  if (!destinationCodexHome) {
    process.stderr.write('Usage: node scripts/spikes/probe-codex-handover.mjs <rollout> <source-cwd> <destination-cwd> <destination-codex-home>\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(`${JSON.stringify(copySession({ rolloutPath, sourceCwd,
      destinationCwd, destinationCodexHome }), null, 2)}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
