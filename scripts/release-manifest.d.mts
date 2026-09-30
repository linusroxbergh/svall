export const MANIFEST: string;
export const SUMS: string;
export const SIG: string;
export const NAMESPACE: string;

export interface Entry {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  mode: string;
  size?: number;
  sha256?: string;
  target?: string;
}

export interface Release {
  version: string;
  platform: string;
  unsigned?: boolean;
  entriesDigest: string;
  files: Entry[];
  [key: string]: unknown;
}

export type Verify = (dir: string, signer: string) => void;
export interface VerifyOptions { verify?: Verify; allowUnsigned?: boolean; signer?: string }

export function entriesOf(dir: string): Entry[];
export function manifestDigest(entries: Entry[]): string;
export function writeManifest(dir: string, meta: Record<string, unknown>): { entries: Entry[]; release: Release };
export function signManifest(dir: string, keyFile: string): void;
export function signArchive(archive: string, keyFile: string): void;
export function sshVerify(o: { allowedSigners: string }): Verify;
export function archiveRelease(archive: string, listing: string): { version: string; members: string[] };
export function verifySignature(dir: string, o?: VerifyOptions): boolean;
export function verifyRelease(dir: string, o?: VerifyOptions): { release: Release; entries: Entry[]; signed: boolean; signer?: string };
export function verifyTree(dir: string, o?: VerifyOptions): { release: Release; entries: Entry[] };
