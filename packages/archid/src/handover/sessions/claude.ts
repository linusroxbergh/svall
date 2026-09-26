import path from 'node:path';
import type { Version } from '../../agents.js';
import { filesUnder, transcriptFile } from './records.js';
import { SessionError, type SessionAdapter, type SessionFs } from './types.js';

// the oldest release a fixture holds; Archipelago asks no floor of Claude Code itself
const MIN: Version = [2, 1, 251];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// what a session keeps in its own folder beside the transcript: its subagents, and tool output too long to show inline
const SIDECARS = [/^subagents\/[^/]+\.meta\.json$/, /^subagents\/[^/]+\.jsonl$/, /^tool-results\/[^/]+$/];
const TRANSCRIPT = /^projects\/[^/]+\/([^/]+)\.jsonl$/;
const SIDECAR = /^projects\/[^/]+\/[^/]+\/(.+)$/;

/** Whether `file` is session `sessionId`'s, whose transcript sits at `transcript`: that transcript, or a sidecar in its folder. */
function carries(file: string, transcript: string, sessionId: string): boolean {
  if (!UUID.test(sessionId) || TRANSCRIPT.exec(transcript)?.[1] !== sessionId) return false;
  if (file === transcript) return true;
  const inner = SIDECAR.exec(file)?.[1];
  return file.startsWith(`${transcript.slice(0, -'.jsonl'.length)}/`) && inner !== undefined && SIDECARS.some((re) => re.test(inner));
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
    // file history stays, since its backups name machine-local files, and so does session-env, which can hold secrets
    const folder = path.posix.join(path.posix.dirname(transcript), sessionId);
    const sidecars = (await filesUnder(fs, home, folder)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const unknown = sidecars.filter((f) => !carries(f, transcript, sessionId)).map((f) => f.slice(folder.length + 1));
    if (unknown.length) {
      const named = `${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ''}`;
      throw new SessionError('incompatible_adapter', `${path.posix.join(home, folder)} holds ${named}, which Claude Code session adapter 1 does not carry`);
    }
    return { home, transcript, files: [transcript, ...sidecars] };
  },

  carries,
};
