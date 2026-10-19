// cores kept busy, from a percent of one core: two decimals below one core, one above
export function coresText(pct: number): string {
  const cores = pct / 100;
  return cores.toFixed(cores < 1 ? 2 : 1);
}

export function memText(bytes: number): string {
  const mb = bytes / 2 ** 20;
  return Math.round(mb) >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
