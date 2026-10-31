import type { ContextItem } from '@svall/protocol';
import { Machine } from './icons.js';

export const reviewText = (pr: ContextItem): string => {
  const n = /\/pull\/(\d+)/.exec(pr.ref)?.[1];
  return n ? `PR #${n} in review` : 'PR in review';
};

export const subagentsText = (n: number): string => `${n} subagent${n === 1 ? '' : 's'} running`;

export const MONITORING = 'Monitoring\nThe agent watches something in the background and acts when it changes';

/** The machine a robot on a worker runs on, after its glyph: "Runs on NAME", or "on NAME" with the full words in its tip. */
export function MachineLine({ name, short, className, testid }: { name: string; short?: boolean; className: string; testid: string }) {
  return (
    <span className={`mline ${className}`} data-testid={testid} data-tip={short ? `Runs on ${name}` : undefined}>
      <Machine /><span>{short ? 'on' : 'Runs on'} <b>{name}</b></span>
    </span>
  );
}
