export const VENDOR: string;
export const PINS: {
  node: { version: string; platforms: string[]; sha256: Record<string, string> };
  rsync: { version: string; sha256: string };
};

export function describeVersion(repo?: string): string;
export function nodeRuntime(platform: string, o?: { vendor?: string; shasums?: string }): Promise<{ version: string; platform: string; tarball: string; name: string; sha256: string; verifiedAgainst: string }>;
export function schemaVersions(work: string): Promise<{ protocol: number; stateSchema: number; transferSchema: number; authoritySchema: number }>;
export function shimText(name: string): string;
export function companionAssets(o: { dir: string; version: string; urlBase: string }): Record<string, { url: string; sha256: string }>;
export function carryCompanions(stage: string, companions: Record<string, { url: string; sha256: string }>, dir: string): void;
export function stageRelease(o: { out: string; version: string; platform: string; shasums?: string; companionUrlBase?: string; companionDir?: string }): Promise<{ stage: string; meta: Record<string, unknown> }>;
export function releaseKey(): string | undefined;
export function packageLicence(dir: string): { name: string; version: string; license: string; file: string };
export function phonePackages(repo?: string): string[];
export const RSYNC_CONFIGURE: string[];
export function pinnedRsync(arch: string, o?: { vendor?: string; fresh?: boolean }): Promise<{ version: string; binary: string; licence: string; tarball: string; sha256: string }>;
