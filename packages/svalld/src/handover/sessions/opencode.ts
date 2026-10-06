import fs from 'node:fs';
import path from 'node:path';
import { AGENTS } from '../../agents.js';
import { transcriptFile } from './records.js';
import { SessionError, type CliRun, type SessionAdapter, type SessionFs } from './types.js';

const SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const exportFile = (sessionId: string): string => `exports/${sessionId}.json`;

// the first line OpenCode gave for itself, or why it could not be asked
const said = (r: { stdout: string; stderr: string }): string => (r.stderr.trim() || r.stdout.trim()).split('\n')[0].slice(0, 300);

async function ask(run: CliRun, args: string[], o?: { stdout?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  try { return await run('opencode', args, o); } catch (e) {
    return { code: -1, stdout: '', stderr: (e as Error).message };
  }
}

export const opencodeAdapter: SessionAdapter = {
  kind: 'opencode',
  adapter: 1,
  min: AGENTS.opencode.minVersion ?? [0, 0, 0],
  // Svall's plugin reports a session resumed with -s as it starts
  sessionStartOnResume: true,

  // OpenCode keeps the session in its database, and Svall's plugin logs it as <fleet home>/transcripts/opencode/<id>.jsonl;
  // the session travels as that log and its export
  async discover(transcriptPath: string, sessionId: string, fs: SessionFs) {
    const file = path.posix.normalize(transcriptPath);
    if (!SESSION.test(sessionId) || path.posix.basename(file) !== `${sessionId}.jsonl`) {
      throw new SessionError('transcript_missing', `${transcriptPath} is not the log of session ${sessionId}`);
    }
    const home = path.posix.dirname(file);
    if (!file.startsWith('/') || path.posix.basename(home) !== 'opencode' || path.posix.basename(path.posix.dirname(home)) !== 'transcripts') {
      throw new SessionError('incompatible_adapter', `${transcriptPath} is not in the folder Svall logs OpenCode sessions in`);
    }
    await transcriptFile(fs, file);
    const transcript = path.posix.basename(file);
    return { home, transcript, files: [transcript, exportFile(sessionId)] };
  },

  carries: (file, transcript, sessionId) =>
    SESSION.test(sessionId) && transcript === `${sessionId}.jsonl` && (file === transcript || file === exportFile(sessionId)),

  exportFile,

  async exportSession(sessionId, file, run) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const r = await ask(run, ['session', 'export', '--standalone', sessionId], { stdout: file });
    if (r.code !== 0) throw new SessionError('transcript_missing', `OpenCode holds no session ${sessionId} to carry: ${said(r)}`);
  },

  // the incoming copy replaces one an earlier handover left here, which this machine's log proved it did not go on with.
  // Import exits 0 on an id it already holds, and a resume with -s on an id it does not hold starts an empty session
  async importSession(sessionId, file, cwd, run) {
    const gone = await ask(run, ['session', 'delete', '--standalone', sessionId]);
    if (gone.code !== 0 && !/Session not found/.test(gone.stderr + gone.stdout)) {
      throw new SessionError('transcript_missing', `OpenCode could not remove its earlier copy of session ${sessionId}: ${said(gone)}`);
    }
    const r = await ask(run, ['session', 'import', '--standalone', '--directory', cwd, file]);
    if (r.code !== 0 || !r.stdout.split('\n').some((l) => l.trim() === `Imported session: ${sessionId}`)) {
      throw new SessionError('transcript_missing', `OpenCode did not import session ${sessionId}: ${said(r)}`);
    }
  },
};
