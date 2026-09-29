import type { Entry, Release, Verify, VerifyOptions } from './release-manifest.mjs';

export const DEFAULT_PREFIX: string;
export function allowedSigners(): string;

export interface InstallOptions {
  source: string;
  prefix?: string;
  signer?: string;
  allowUnsigned?: boolean;
  verify?: Verify;
}

export interface Installed {
  prefix: string;
  version: string;
  current: string;
  release: string;
  signed: boolean;
  replaced: boolean;
  entries: number;
  rollbackTo: string | null;
  releasesKept: string[];
}

export interface Staged {
  version: string;
  /** `<staging>/releases/<version>`, authenticated */
  dir: string;
  release: Release;
  entries: Entry[];
  signed: boolean;
}

export function stageArchive(archive: string, staging: string, o?: VerifyOptions): Staged;
export function installRelease(o: InstallOptions): Installed;
export function main(argv: string[]): Installed;

export interface RolledBack {
  prefix: string;
  current: string;
  release: string;
  version: string;
  from: string | null;
}

export function rollbackRelease(prefix?: string, to?: string): RolledBack;
