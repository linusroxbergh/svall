import { frame, paint, RES } from './glow.js';

const read = (blob: Blob) => new Promise<string>((done) => {
  const r = new FileReader();
  r.onload = () => done(r.result as string);
  r.readAsDataURL(blob);
});

// a drawing that throws reaches the page as the worker's error; a canvas that reads back nothing, as the page's does while
// WebKit replaces its GPU process, posts null
onmessage = ({ data: { id, sand, cx, cy } }: MessageEvent<{ id: number; sand: string; cx: number; cy: number }>) => {
  const f = frame(sand, cx, cy);
  const canvas = new OffscreenCanvas(f.w, f.h);
  paint(canvas.getContext('2d')!, sand, cx, cy, f);
  void canvas.convertToBlob().then((b) => (b.size ? read(b) : null), () => null)
    .then((href) => postMessage({ id, g: href && { href, x: f.x, y: f.y, w: f.w / RES, h: f.h / RES } }));
};
