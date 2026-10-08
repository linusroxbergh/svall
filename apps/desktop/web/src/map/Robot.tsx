import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { robotUrl } from '../portraits.js';
import { addRobot } from './motion.js';

// each robot's SVG text, fetched once
const texts = new Map<number, string>();
const loads = new Map<number, Promise<void>>();

function load(n: number): Promise<void> {
  let p = loads.get(n);
  if (!p) {
    p = fetch(robotUrl(n))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
      .then((t) => { texts.set(n, t); }, () => { loads.delete(n); });
    loads.set(n, p);
  }
  return p;
}

// one card's copy of a robot: its ids (and every reference to them) prefixed so copies never share one, hidden from
// assistive tech, in the img's box and bottom-anchored as the img's object-position is
export function inlineRobot(svg: string, prefix: string): string {
  const ids = new Set(Array.from(svg.matchAll(/\sid="([^"]+)"/g), (m) => m[1]));
  const own = (id: string) => (ids.has(id) ? `${prefix}-${id}` : id);
  return svg
    .replace(/(\sid=")([^"]+)"/g, (_, a: string, id: string) => `${a}${own(id)}"`)
    .replace(/url\((['"]?)#([^'")]+)\1\)/g, (_, q: string, id: string) => `url(${q}#${own(id)}${q})`)
    .replace(/(\s(?:xlink:)?href="#)([^"]+)"/g, (_, a: string, id: string) => `${a}${own(id)}"`)
    .replace(/(\saria-labelledby=")([^"]+)"/g, (_, a: string, list: string) => `${a}${list.split(/\s+/).map(own).join(' ')}"`)
    .replace(/<svg\b[^>]*>/, (root) => {
      const cls = root.match(/\sclass="([^"]*)"/)?.[1];
      return `${root.slice(0, -1).replace(/\sclass="[^"]*"/, '')} class="${cls ? `${cls} ` : ''}portrait robot" aria-hidden="true" preserveAspectRatio="xMidYMax meet">`;
    });
}

let cards = 0;

// the robot inline, so its own actions can play on it; the img stands in until its text arrives
export function Robot({ n }: { n: number }) {
  const [prefix] = useState(() => `bot${++cards}`);
  const [, loaded] = useReducer((x: number) => x + 1, 0);
  const text = texts.get(n);
  useEffect(() => { if (!texts.has(n)) void load(n).then(loaded); }, [n]);
  const svg = useMemo(() => text && inlineRobot(text, prefix), [text, prefix]);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bot = stage.current?.firstElementChild;
    return bot instanceof SVGElement ? addRobot(bot) : undefined;
  }, [svg]);
  return svg
    ? <div key="svg" ref={stage} className="stage" data-robot={n} dangerouslySetInnerHTML={{ __html: svg }} />
    : <div key="img" className="stage" data-robot={n}><img className="portrait robot" src={robotUrl(n)} alt="" draggable={false} /></div>;
}
