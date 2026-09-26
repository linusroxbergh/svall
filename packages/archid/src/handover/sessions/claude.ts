import path from 'node:path';
import type { Version } from '../../agents.js';
import { filesUnder, transcriptFile } from './records.js';
import { SessionError, type SessionAdapter, type SessionFs } from './types.js';

// the oldest release a fixture holds; Archipelago asks no floor of Claude Code itself
const MIN: Version = [2, 1, 251];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSCRIPT = /^projects\/[^/]+\/([^/]+)\.jsonl$/;

/** Whether `file` is session `sessionId`'s, whose transcript sits at `transcript`: that transcript, or a file in the session's own folder beside it. */
function carries(file: string, transcript: string, sessionId: string): boolean {
  if (!UUID.test(sessionId) || TRANSCRIPT.exec(transcript)?.[1] !== sessionId) return false;
  return file === transcript || file.startsWith(`${transcript.slice(0, -'.jsonl'.length)}/`);
}

export const claudeAdapter: SessionAdapter = {
  kind: 'claude',
  adapter: 1,
  min: MIN,
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
};
