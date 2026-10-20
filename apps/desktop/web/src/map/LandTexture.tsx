import grainUrl from '../assets/map-grain.png';

// The same small tile stays anchored to island coordinates as the map pans and zooms.
// A CSS background, not an SVG pattern, so WebKit draws the tile itself rather than a new buffer of it per repaint.
export function LandTexture({ shape }: { shape: string }) {
  return <div className="land-texture" style={{ clipPath: `path("${shape}")`, backgroundImage: `url(${grainUrl})` }} />;
}
