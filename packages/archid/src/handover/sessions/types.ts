import type { AgentKind, HandoverIssueCode, ResumeFolder } from '@archipelago/protocol';

/** The CLI releases an adapter was tested against, both ends included. */
export type VersionRange = { min: string; max: string };

/** Where a source path lands on the destination; undefined when no agent home holds it. */
export type PathMap = (absolute: string) => string | undefined;

/** One session as its source keeps it: the agent home, and each file under it with the transcript first. */
export type FoundSession = { home: string; transcript: string; files: string[] };

type Entry = { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };

/** The reads discovery makes, so a manifest scan can pass its own. */
export type SessionFs = {
  lstat(p: string): Promise<Entry>;
  readdir(p: string): Promise<Buffer[]>;
};

export type SessionIssueCode = Extract<HandoverIssueCode, 'transcript_missing' | 'incompatible_adapter' | 'path_unsupported' | 'destination_diverged'>;

/** Why a session cannot move as it is, with the blocker code a handover reports it under. */
export class SessionError extends Error {
  constructor(readonly code: SessionIssueCode, message: string) {
    super(message);
  }
}

/**
 * What one agent's session files look like for a range of its CLI releases: which files make a session,
 * and which of their fields name a path on the machine that wrote them.
 */
export interface SessionAdapter {
  readonly kind: AgentKind;
  /** This adapter's own version, as `system.info` reports it. */
  readonly adapter: number;
  readonly versions: VersionRange;
  /** Whether the CLI runs its SessionStart hook as a resumed session starts; one that does not runs it with the first turn. */
  readonly sessionStartOnResume: boolean;
  /** Whether this CLI release is one the adapter was tested against. */
  supports(version: string): boolean;
  /** The files one session is made of, found from the exact transcript its terminal recorded. */
  discover(transcriptPath: string, sessionId: string, fs: SessionFs): Promise<FoundSession>;
  /** Whether `file`, relative to the agent home, is one of session `sessionId`'s files when its transcript is `transcript`. */
  carries(file: string, transcript: string, sessionId: string): boolean;
  /** A carried file with its known path fields mapped and every other byte kept. Throws on what it does not know. */
  rewrite(file: string, data: Buffer, map: PathMap): Buffer;
  /** What in a carried file this adapter does not know; empty when `rewrite` can take it. */
  validate(file: string, data: Buffer, map: PathMap): string[];
  /** Whether the CLI, keeping its files in `home`, resumes in `folder` without first asking whether to trust it; absent for one that never asks. */
  trusts?(home: string, folder: Omit<ResumeFolder, 'kind'>): boolean;
}
