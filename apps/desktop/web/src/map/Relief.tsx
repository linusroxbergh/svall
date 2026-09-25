const CONTOURS: [number, string][] = [
  [1.2, 'var(--contour-2)'],
  [1.12, 'var(--contour-2)'],
  [1.055, 'var(--contour)'],
];

const around = (k: number, cx: number, cy: number) => `translate(${cx},${cy}) scale(${k}) translate(${-cx},${-cy})`;

// everything drawn under the land: the shoals lightening the sea, the cast shadow, the wave-line contours and the sand bank
export function Seabed({ id, sand, cx, cy, bank }: { id: string; sand: string; cx: number; cy: number; bank: string }) {
  const soft = `soft-${id}`, sharp = `sharp-${id}`;
  return (
    <>
      <defs>
        <filter id={soft} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9" /></filter>
        <filter id={sharp} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5" /></filter>
      </defs>
      <path d={sand} fill="rgba(140,190,215,.13)" filter={`url(#${soft})`} transform={around(1.3, cx, cy)} />
      <path d={sand} fill="rgba(205,225,230,.10)" filter={`url(#${sharp})`} transform={around(1.1, cx, cy)} />
      <path d={sand} fill="rgba(8,14,22,.22)" filter={`url(#${sharp})`} transform="translate(2,8)" />
      {CONTOURS.map(([k, colour], i) => (
        <path key={i} d={sand} fill="none" stroke={colour} strokeWidth={(1 / k).toFixed(3)} strokeDasharray="7 9" strokeLinecap="round" transform={around(k, cx, cy)} />
      ))}
      <path d={sand} fill="rgba(70,58,34,.2)" transform="translate(0,7.5)" />
      <path d={sand} fill={bank} transform="translate(0,6.5)" />
    </>
  );
}

export function Waterline({ sand }: { sand: string }) {
  return <path d={sand} fill="none" stroke="rgba(252,246,230,.38)" strokeWidth="1.4" />;
}
