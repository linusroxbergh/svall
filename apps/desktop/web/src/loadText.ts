// one decimal below 10%, whole numbers above
export function cpuText(pct: number): string {
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

export function memText(bytes: number): string {
  const mb = bytes / 2 ** 20;
  return Math.round(mb) >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
