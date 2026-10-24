import fs from 'node:fs';
import path from 'node:path';
import type { ResumeFolder } from '@svall/protocol';
import { parse as parseToml } from 'smol-toml';
import { AGENTS } from '../../agents.js';
import { realPath } from '../portable-path.js';
import { transcriptFile } from './records.js';
import { SessionError, type SessionAdapter, type SessionFs } from './types.js';

const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const DATED = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];

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
  // every release counts when Svall sets no floor for Codex
  min: AGENTS.codex.minVersion ?? [0, 0, 0],
  sessionStartOnResume: false,

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

  trusts,
};
