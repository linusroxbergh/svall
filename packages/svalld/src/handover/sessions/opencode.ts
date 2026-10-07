import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS } from '../../agents.js';
import { writeDurable } from '../durable.js';
import { transcriptFile } from './records.js';
import { SessionError, type CliRun, type SessionAdapter, type SessionFs } from './types.js';

const SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const exportFile = (sessionId: string): string => `exports/${sessionId}.json`;

// the first line OpenCode gave for itself, or why it could not be asked
const said = (r: { stdout: string; stderr: string }): string => (r.stderr.trim() || r.stdout.trim()).split('\n')[0].slice(0, 300);

async function ask(run: CliRun, args: string[], o: { stdout?: string; cwd: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  // a folder gone here would read as an OpenCode that cannot be run
  try { return await run('opencode', args, { ...o, cwd: fs.existsSync(o.cwd) ? o.cwd : os.homedir() }); } catch (e) {
    throw new SessionError('agent_cli_missing', `OpenCode could not be run on this machine: ${(e as Error).message}`);
  }
}

const notFound = (r: { stdout: string; stderr: string }): boolean => /Session not found/.test(r.stderr + r.stdout);

const imported = (r: { stdout: string }, sessionId: string): boolean => r.stdout.split('\n').some((l) => l.trim() === `Imported session: ${sessionId}`);

// the message ids of an export, in order
const ids = (file: string): string[] | undefined => {
  try {
    const messages = (JSON.parse(fs.readFileSync(file, 'utf8')) as { messages?: unknown }).messages;
    return Array.isArray(messages) ? messages.map((m) => String((m as { id?: unknown }).id)) : undefined;
  } catch { return undefined; }
};

// the session an export describes: the folder it ran in on the machine that wrote it out, and any undo it has pending
const infoOf = (file: string): { location?: { directory?: unknown }; revert?: unknown } | undefined => {
  try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as { info?: { location?: { directory?: unknown }; revert?: unknown } }).info; } catch { return undefined; }
};

const folderOf = (file: string): string | undefined => {
  const directory = infoOf(file)?.location?.directory;
  return typeof directory === 'string' ? directory : undefined;
};

// writes this machine's copy of a session out to `to`, answering false when it holds none; a copy holding a message the
// one coming in at `file` lacks went on here, whether in Svall or in a plain `opencode -s`, which Svall's log never sees
async function heldCopy(sessionId: string, file: string, to: string, cwd: string, run: CliRun): Promise<boolean> {
  const r = await ask(run, ['session', 'export', '--standalone', sessionId], { stdout: to, cwd });
  if (r.code !== 0) {
    if (notFound(r)) return false;
    throw new SessionError('transcript_missing', `OpenCode could not read its copy of session ${sessionId}: ${said(r)}`);
  }
  const [held, incoming] = [ids(to), ids(file)];
  if (!incoming) throw new SessionError('transcript_missing', `the export of session ${sessionId} that came is not one OpenCode wrote`);
  if (!held || held.some((id, i) => incoming[i] !== id)) {
    throw new SessionError('destination_diverged', `this machine's OpenCode went on with session ${sessionId} past the copy coming in`);
  }
  return true;
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

  async exportSession(sessionId, file, run, cwd) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const r = await ask(run, ['session', 'export', '--standalone', sessionId], { stdout: file, cwd });
    if (r.code !== 0) throw new SessionError('transcript_missing', `OpenCode holds no session ${sessionId} to carry: ${said(r)}`);
    // import drops a pending undo, so the turns it hides would come back to life on the destination
    if (infoOf(file)?.revert) {
      throw new SessionError('transcript_missing', `OpenCode session ${sessionId} has an undo pending: send a message or /redo, then hand over`);
    }
  },

  async checkSession(sessionId, file, cwd, run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-opencode-'));
    try { await heldCopy(sessionId, file, path.join(dir, 'held.json'), cwd, run); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },

  // a copy an earlier handover left here goes, unless it went on past the incoming session
  async dropSession(sessionId, file, cwd, run, keep) {
    const here = `${file}.here`;
    try {
      if (!(await heldCopy(sessionId, file, here, cwd, run))) return;
      if (!fs.existsSync(keep)) {
        fs.mkdirSync(path.dirname(keep), { recursive: true, mode: 0o700 });
        writeDurable(keep, fs.readFileSync(here), { mode: 0o600 });
      }
    } finally {
      fs.rmSync(here, { force: true });
    }
    const gone = await ask(run, ['session', 'delete', '--standalone', sessionId], { cwd });
    if (gone.code !== 0 && !notFound(gone)) {
      throw new SessionError('transcript_missing', `OpenCode could not remove its earlier copy of session ${sessionId}: ${said(gone)}`);
    }
  },

  // import exits 0 on an id it already holds, and a resume with -s on an id it does not hold starts an empty session
  async importSession(sessionId, file, cwd, run) {
    const r = await ask(run, ['session', 'import', '--standalone', '--directory', cwd, file], { cwd });
    if (r.code !== 0 || !imported(r, sessionId)) {
      throw new SessionError('transcript_missing', `OpenCode did not import session ${sessionId}: ${said(r)}`);
    }
  },

  async restoreSession(sessionId, kept, run) {
    const folder = folderOf(kept);
    if (!folder) throw new SessionError('transcript_missing', `${kept} is not the copy of session ${sessionId} this machine's OpenCode held`);
    const r = await ask(run, ['session', 'import', '--standalone', '--directory', folder, kept], { cwd: folder });
    if (r.code !== 0 || !(imported(r, sessionId) || /Session already exists/.test(r.stderr))) {
      throw new SessionError('transcript_missing', `OpenCode could not take back its copy of session ${sessionId}, kept at ${kept}: ${said(r)}`);
    }
  },
};
