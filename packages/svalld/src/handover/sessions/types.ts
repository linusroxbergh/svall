import type { AgentKind, HandoverIssueCode, ResumeFolder } from '@svall/protocol';
import type { Version } from '../../agents.js';

/** One session as its source keeps it: the agent home, and each file under it with the transcript first. */
export type FoundSession = { home: string; transcript: string; files: string[] };

type Entry = { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };

/** The reads discovery makes, so a manifest scan can pass its own. */
export type SessionFs = {
  lstat(p: string): Promise<Entry>;
  readdir(p: string): Promise<Buffer[]>;
};

/** Runs an agent CLI in `cwd` to its exit, its stdout into the file `stdout` names when it names one; rejects only when it cannot start. */
export type CliRun = (cmd: string, args: string[], o?: { stdout?: string; cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

export type SessionIssueCode = Extract<HandoverIssueCode, 'transcript_missing' | 'incompatible_adapter' | 'path_unsupported' | 'destination_diverged' | 'agent_cli_missing'>;

/** Why a session cannot move as it is, with the blocker code a handover reports it under. */
export class SessionError extends Error {
  constructor(readonly code: SessionIssueCode, message: string) {
    super(message);
  }
}

/**
 * Where one agent's CLI keeps a session's files, from its oldest release this adapter carries on: which files make
 * a session. The files are copied byte for byte, so what they hold is never read.
 */
export interface SessionAdapter {
  readonly kind: AgentKind;
  /** This adapter's own version, as `system.info` reports it. */
  readonly adapter: number;
  /** The oldest CLI release whose sessions this adapter carries; every newer one counts too. */
  readonly min: Version;
  /** Whether the CLI runs its SessionStart hook as a resumed session starts; one that does not runs it with the first turn. */
  readonly sessionStartOnResume: boolean;
  /** The files one session is made of, found from the exact transcript its terminal recorded. */
  discover(transcriptPath: string, sessionId: string, fs: SessionFs): Promise<FoundSession>;
  /** Whether `file`, relative to the agent home, is one of session `sessionId`'s files when its transcript is `transcript`. */
  carries(file: string, transcript: string, sessionId: string): boolean;
  /** Whether the CLI, keeping its files in `home`, resumes in `folder` without first asking whether to trust it; absent for one that never asks. */
  trusts?(home: string, folder: Omit<ResumeFolder, 'kind'>): boolean;
  /** The choice at that question that goes on, when it is not the one the CLI preselects. */
  readonly trustAnswer?: string;
  /** Whether a resume command, as a revive keeps it, starts the CLI in bypass mode; absent for a CLI with no such mode to warn about. */
  asksBypass?(command: string): boolean;
  /** Whether the CLI, keeping its files in `home`, starts in bypass mode in `folder` without first warning about it. */
  acceptsBypass?(home: string, folder: Omit<ResumeFolder, 'kind'>): boolean;
  /**
   * For a CLI that keeps its sessions in a database of its own: the file under the agent home a handover writes the
   * session out to, which travels with its files and is read back in on the destination rather than placed.
   */
  exportFile?(sessionId: string): string;
  /** Writes the session out of this machine's CLI into `file`, running the CLI in `cwd`. */
  exportSession?(sessionId: string, file: string, run: CliRun, cwd: string): Promise<void>;
  /** Removes this machine's copy of the session, unless it went on past the one written out at `file`. */
  dropSession?(sessionId: string, file: string, cwd: string, run: CliRun): Promise<void>;
  /** Puts the session written out at `file` into this machine's CLI, which holds no copy of it, to resume in `cwd`. */
  importSession?(sessionId: string, file: string, cwd: string, run: CliRun): Promise<void>;
}
