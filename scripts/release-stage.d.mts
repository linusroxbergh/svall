export const VENDOR: string;
export const PINS: {
  node: { version: string; platforms: string[] };
  rsync: { version: string; sha256: string };
};

export function describeVersion(): string;
export function shimText(name: string): string;
export function companionAssets(o: { dir: string; version: string; urlBase: string }): Record<string, { url: string; sha256: string }>;
export function stageRelease(o: { out: string; version: string; platform: string; shasums?: string; companionUrlBase?: string; companionDir?: string }): Promise<{ stage: string; meta: Record<string, unknown> }>;
export function releaseKey(): string | undefined;
