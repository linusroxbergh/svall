import grainUrl from '../assets/map-grain.png';

// The same small tile stays anchored to island coordinates as the map pans and zooms.
// Keep the overlay out of hit testing: the land paths below own dragging and clicks.
export function LandTexture({ id, shape }: { id: string; shape: string }) {
  const pattern = `texture-${id}`;
  return (
    <>
      <defs>
        <pattern id={pattern} patternUnits="userSpaceOnUse" width="128" height="128">
          <image href={grainUrl} width="128" height="128" />
        </pattern>
      </defs>
      <path className="land-texture" d={shape} fill={`url(#${pattern})`} pointerEvents="none" />
    </>
  );
}
