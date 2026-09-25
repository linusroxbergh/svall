import type { Verify } from './release-manifest.mjs';

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
