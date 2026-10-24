export interface Hit { input: string; path: string; rule: string; excerpt: string; count: number }
export interface ScanOptions { home?: string; checkout?: string; tmp?: string; secretsOnly?: boolean }

export function scan(inputs: string[], o?: ScanOptions): { hits: Hit[]; scanned: { input: string; files: number }[] };
