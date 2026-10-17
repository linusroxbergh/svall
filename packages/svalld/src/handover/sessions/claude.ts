import fs from 'node:fs';
import path from 'node:path';
import type { ResumeFolder } from '@svall/protocol';
import { AGENTS } from '../../agents.js';
import { claudePaths } from '../../paths.js';
import { holds, realPath } from '../portable-path.js';
import { filesUnder, transcriptFile } from './records.js';
import { SessionError, type SessionAdapter, type SessionFs } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSCRIPT = /^projects\/[^/]+\/([^/]+)\.jsonl$/;

/** Whether `file` is session `sessionId`'s, whose transcript sits at `transcript`: that transcript, or a file in the session's own folder beside it. */
function carries(file: string, transcript: string, sessionId: string): boolean {
  if (!UUID.test(sessionId) || TRANSCRIPT.exec(transcript)?.[1] !== sessionId) return false;
  return file === transcript || file.startsWith(`${transcript.slice(0, -'.jsonl'.length)}/`);
}

// Claude reads a legacy .config.json in its config folder first, else .claude.json in CLAUDE_CONFIG_DIR, or beside ~/.claude
function configOf(home: string): string {
  const legacy = path.join(home, '.config.json');
  if (fs.existsSync(legacy)) return legacy;
  const byDefault = claudePaths();
  return path.resolve(home) === byDefault.dir ? byDefault.json : path.join(home, '.claude.json');
}

const readJson = (file: string): Record<string, unknown> | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
};

// the config can run to megabytes and a watch asks it again and again, so it is read again only once it has changed
let config: { file: string; stamp: string; value?: Record<string, unknown> } | undefined;
function readConfig(home: string): Record<string, unknown> | undefined {
  const file = configOf(home);
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) return undefined;
  const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  if (config?.file !== file || config.stamp !== stamp) config = { file, stamp, value: readJson(file) };
  return config.value;
}

/**
 * As Claude 2.1.283 decides, by real paths composed to NFC: a folder is trusted through its repository's main checkout,
 * or through itself or a folder above it, up to the top of its checkout or, outside one, up to /.
 */
function trusts(home: string, folder: Omit<ResumeFolder, 'kind'>): boolean {
  const projects = readConfig(home)?.projects;
  if (!projects || typeof projects !== 'object') return false;
  const entries = projects as Record<string, { hasTrustDialogAccepted?: unknown } | undefined>;
  const trusted = (p: string) => Object.hasOwn(entries, p) && entries[p]?.hasTrustDialogAccepted === true;
  const key = (p: string) => realPath(p).normalize('NFC');
  if (folder.repo && trusted(key(folder.repo))) return true;
  const top = folder.root && key(folder.root);
  for (let p = key(folder.cwd); !top || holds(top, p); p = path.dirname(p)) {
    if (trusted(p)) return true;
    if (p === top || p === path.dirname(p)) return false;
  }
  return false;
}

// the launch flags a revive keeps that start Claude in bypass mode
const BYPASS = /(?:^| )(?:--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--permission-mode 'bypassPermissions')(?= |$)/;

/**
 * As Claude 2.1.283 decides: bypass mode is accepted by its config, which a start moves into its settings, by its
 * settings, or by the local settings of the folder or of its repository's main checkout.
 */
function acceptsBypass(home: string, folder: Omit<ResumeFolder, 'kind'>): boolean {
  const skips = (file: string) => readJson(file)?.skipDangerousModePermissionPrompt === true;
  if (readConfig(home)?.bypassPermissionsModeAccepted === true || skips(path.join(home, 'settings.json'))) return true;
  return [folder.cwd, folder.repo].some((d) => d !== undefined && skips(path.join(d, '.claude', 'settings.local.json')));
}

export const claudeAdapter: SessionAdapter = {
  kind: 'claude',
  adapter: 1,
  min: AGENTS.claude.minVersion ?? [0, 0, 0],
  sessionStartOnResume: true,

  // <config>/projects/<slug>/<id>.jsonl, with the session's own folder beside it
  async discover(transcriptPath: string, sessionId: string, fs: SessionFs) {
    const file = path.posix.normalize(transcriptPath);
    if (!UUID.test(sessionId) || path.posix.basename(file) !== `${sessionId}.jsonl`) {
      throw new SessionError('transcript_missing', `${transcriptPath} is not the transcript of session ${sessionId}`);
    }
    const project = path.posix.dirname(file);
    const projects = path.posix.dirname(project);
    if (!file.startsWith('/') || path.posix.basename(projects) !== 'projects') {
      throw new SessionError('incompatible_adapter', `${transcriptPath} is not in a Claude Code projects folder`);
    }
    await transcriptFile(fs, file);
    const home = path.posix.dirname(projects);
    const transcript = path.posix.relative(home, file);
    // the session's own folder travels whole; file history stays, since its backups name machine-local files, and so
    // does session-env, which can hold secrets
    const folder = path.posix.join(path.posix.dirname(transcript), sessionId);
    const sidecars = (await filesUnder(fs, home, folder)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { home, transcript, files: [transcript, ...sidecars] };
  },

  carries,

  trusts,
  // its prompt preselects "No, exit"
  trustAnswer: 'Yes, I trust this folder',

  asksBypass: (command) => BYPASS.test(command),
  acceptsBypass,
};
