import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { figureUrl } from '../portraits.js';
import { addFigure } from './motion.js';

// each robot's SVG text, fetched once
const texts = new Map<number, string>();
const loads = new Map<number, Promise<void>>();

// every design's actions in one sheet that only grows: a robot mounting or leaving never changes the page's sheets
let shared: HTMLStyleElement | undefined;
function hoist(svg: string): string {
  return svg.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_, css: string) => {
    shared ??= document.head.appendChild(document.createElement('style'));
    shared.append(css);
    return '';
  });
}

function load(n: number): Promise<void> {
  let p = loads.get(n);
  if (!p) {
    p = fetch(figureUrl(n))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
      .then((t) => { texts.set(n, hoist(t)); }, () => { loads.delete(n); });
    loads.set(n, p);
  }
  return p;
}

// one card's copy of a robot: its ids (and every reference to them) prefixed so copies never share one, hidden from
// assistive tech, in the img's box and bottom-anchored as the img's object-position is
export function inlineFigure(svg: string, prefix: string): string {
  const ids = new Set(Array.from(svg.matchAll(/\sid="([^"]+)"/g), (m) => m[1]));
  const own = (id: string) => (ids.has(id) ? `${prefix}-${id}` : id);
  // WKWebView's page zoom moves a px transform-origin on an SVG part to zoom × itself, but leaves a share of the view box in place
  const [, , w, h] = (svg.match(/<svg\b[^>]*\sviewBox="([^"]+)"/)?.[1] ?? '').split(/[\s,]+/).map(Number);
  return svg
    .replace(/transform-origin:(-?[\d.]+)px (-?[\d.]+)px/g, (o, x: string, y: string) => (w && h ? `transform-origin:${(+x / w) * 100}% ${(+y / h) * 100}%` : o))
    .replace(/(\sid=")([^"]+)"/g, (_, a: string, id: string) => `${a}${own(id)}"`)
    .replace(/url\((['"]?)#([^'")]+)\1\)/g, (_, q: string, id: string) => `url(${q}#${own(id)}${q})`)
    .replace(/(\s(?:xlink:)?href="#)([^"]+)"/g, (_, a: string, id: string) => `${a}${own(id)}"`)
    .replace(/(\saria-labelledby=")([^"]+)"/g, (_, a: string, list: string) => `${a}${list.split(/\s+/).map(own).join(' ')}"`)
    .replace(/<svg\b[^>]*>/, (root) => {
      const cls = root.match(/\sclass="([^"]*)"/)?.[1];
      return `${root.slice(0, -1).replace(/\sclass="[^"]*"/, '')} class="${cls ? `${cls} ` : ''}portrait figure" aria-hidden="true" preserveAspectRatio="xMidYMax meet">`;
    });
}

let cards = 0;

// the robot inline, so its own actions can play on it; the img stands in until its text arrives
export function Figure({ n }: { n: number }) {
  const [prefix] = useState(() => `bot${++cards}`);
  const [, loaded] = useReducer((x: number) => x + 1, 0);
  const text = texts.get(n);
  useEffect(() => { if (!texts.has(n)) void load(n).then(loaded); }, [n]);
  const svg = useMemo(() => text && inlineFigure(text, prefix), [text, prefix]);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bot = stage.current?.firstElementChild;
    return bot instanceof SVGElement ? addFigure(bot) : undefined;
  }, [svg]);
  return svg
    ? <div key="svg" ref={stage} className="stage" data-figure={n} dangerouslySetInnerHTML={{ __html: svg }} />
    : <div key="img" className="stage" data-figure={n}><img className="portrait figure" src={figureUrl(n)} alt="" draggable={false} /></div>;
}
