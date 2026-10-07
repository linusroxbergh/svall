#!/usr/bin/env node
// An M0 spike probe (docs/fleet-handover/spike-results.md). Manual: running it by hand on a session a real Claude wrote.
// The svalld suite runs it on the fixture sessions in packages/svalld/test/handover/claude-portability.test.ts.

// A disposable-session probe, not the production transfer adapter. Never copies auth/config files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METADATA_PATH_KEYS = new Set([
  'cwd', 'relocatedCwd', 'originalCwd', 'preEnterOriginalCwd', 'worktreePath',
  'workingDirectory', 'scratchpadDirectory', 'trackingPath', 'realParentDir',
  'fullPath', 'projectPath', 'originalPath', 'filename',
]);
const HISTORY_KEYS = new Set(['message', 'toolUseResult', 'wireToolInputs', 'content', 'rendered']);

export const projectSlug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

function within(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function rewritePath(value, mappings) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
  for (const [from, to] of mappings) {
    if (within(value, from)) return `${to}${value.slice(from.length)}`;
  }
  return value;
}

export function relocateMetadata(value, mappings, parentKey = '') {
  if (Array.isArray(value)) return value.map((item) => relocateMetadata(item, mappings, parentKey));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (HISTORY_KEYS.has(key)) { result[key] = item; continue; }
    if (typeof item === 'string' && (METADATA_PATH_KEYS.has(key) ||
      (key === 'path' && parentKey === 'files'))) {
      result[key] = rewritePath(item, mappings);
    } else if (key === 'trackedFileBackups' && item && typeof item === 'object' && !Array.isArray(item)) {
      result[key] = Object.fromEntries(Object.entries(item).map(([file, backup]) =>
        [rewritePath(file, mappings), relocateMetadata(backup, mappings, key)]));
    } else {
      result[key] = relocateMetadata(item, mappings, key);
    }
  }
  return result;
}

function rewriteJsonl(source, destination, mappings) {
  const lines = fs.readFileSync(source, 'utf8').split('\n');
  const rewritten = lines.map((line) => line ? JSON.stringify(relocateMetadata(JSON.parse(line), mappings)) : line);
  fs.writeFileSync(destination, rewritten.join('\n'), { flag: 'wx', mode: 0o600 });
}

function copySessionTree(source, destination, mappings, files) {
  if (!fs.existsSync(source)) return;
  if (fs.existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing session symlink: ${from}`);
    if (entry.isDirectory()) copySessionTree(from, to, mappings, files);
    else if (entry.isFile()) {
      if (entry.name.endsWith('.jsonl')) rewriteJsonl(from, to, mappings);
      else if (entry.name.endsWith('.json')) fs.writeFileSync(to,
        `${JSON.stringify(relocateMetadata(JSON.parse(fs.readFileSync(from, 'utf8')), mappings))}\n`,
        { flag: 'wx', mode: 0o600 });
      else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      files.push(to);
    } else throw new Error(`Unsupported session entry: ${from}`);
  }
}

export function discoverSession(transcriptPath) {
  const sourceTranscript = path.resolve(transcriptPath);
  const sessionId = path.basename(sourceTranscript, '.jsonl');
  if (!sourceTranscript.endsWith('.jsonl') || !SESSION_ID.test(sessionId))
    throw new Error('Expected a UUID-named Claude transcript JSONL');
  if (fs.lstatSync(sourceTranscript).isSymbolicLink()) throw new Error(`Refusing session symlink: ${sourceTranscript}`);
  if (!fs.statSync(sourceTranscript).isFile()) throw new Error('Transcript is not a file');
  const projectDir = path.dirname(sourceTranscript);
  const projectsDir = path.dirname(projectDir);
  if (path.basename(projectsDir) !== 'projects') throw new Error('Transcript is not under a Claude projects directory');
  return { sessionId, sourceTranscript, projectDir, configDir: path.dirname(projectsDir) };
}

export function copySession({ transcriptPath, sourceCwd, destinationCwd, destinationConfigDir }) {
  const source = discoverSession(transcriptPath);
  if (!path.isAbsolute(sourceCwd) || !path.isAbsolute(destinationCwd) || !path.isAbsolute(destinationConfigDir))
    throw new Error('All cwd and config paths must be absolute');
  const mappings = [[path.resolve(sourceCwd), path.resolve(destinationCwd)]];
  const destinationProjectDir = path.join(destinationConfigDir, 'projects', projectSlug(destinationCwd));
  const destinationTranscript = path.join(destinationProjectDir, `${source.sessionId}.jsonl`);
  if (fs.existsSync(destinationTranscript)) throw new Error(`Destination transcript already exists: ${destinationTranscript}`);
  fs.mkdirSync(destinationProjectDir, { recursive: true, mode: 0o700 });
  const files = [];
  rewriteJsonl(source.sourceTranscript, destinationTranscript, mappings);
  files.push(destinationTranscript);
  copySessionTree(path.join(source.projectDir, source.sessionId),
    path.join(destinationProjectDir, source.sessionId), mappings, files);
  // File-history is session-scoped. Deliberately do not copy session-env: it can contain secrets.
  for (const dir of ['file-history']) {
    copySessionTree(path.join(source.configDir, dir, source.sessionId),
      path.join(destinationConfigDir, dir, source.sessionId), mappings, files);
  }
  const indexPath = path.join(source.projectDir, 'sessions-index.json');
  if (fs.existsSync(indexPath)) {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const entries = (index.entries ?? []).filter((entry) => entry.sessionId === source.sessionId)
      .map((entry) => ({ ...relocateMetadata(entry, mappings), fullPath: destinationTranscript,
        projectPath: destinationCwd }));
    if (entries.length) {
      const destinationIndex = path.join(destinationProjectDir, 'sessions-index.json');
      if (fs.existsSync(destinationIndex)) throw new Error(`Destination index already exists: ${destinationIndex}`);
      fs.writeFileSync(destinationIndex, `${JSON.stringify({ version: index.version, entries,
        originalPath: destinationCwd })}\n`, { flag: 'wx', mode: 0o600 });
      files.push(destinationIndex);
    }
  }
  return { sessionId: source.sessionId, destinationTranscript, files };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [transcriptPath, sourceCwd, destinationCwd, destinationConfigDir] = process.argv.slice(2);
  if (!destinationConfigDir) {
    process.stderr.write('Usage: node scripts/spikes/probe-claude-handover.mjs <transcript> <source-cwd> <destination-cwd> <destination-config-dir>\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(`${JSON.stringify(copySession({ transcriptPath, sourceCwd,
      destinationCwd, destinationConfigDir }), null, 2)}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
