import type { ReactNode } from 'react';

/** The size an icon is shown at, one of the --icon-* tokens; each grid has its own by default. */
export type IconSize = 'xs' | 'sm' | 'md' | 'lg';
type Grid = 10 | 12 | 24;

// one stroke weight per grid: marks on 10, glyphs on 12, icons on 24
const WEIGHT: Record<Grid, number> = { 10: 1.6, 12: 1.25, 24: 1.6 };
const SIZE: Record<Grid, IconSize> = { 10: 'xs', 12: 'sm', 24: 'md' };

type Props = { size?: IconSize };

function Svg({ grid, size, fill, className, dir, children }: Props & { grid: Grid; fill?: boolean; className?: string; dir?: string; children: ReactNode }) {
  return (
    <svg className={`icon-${size ?? SIZE[grid]}${className ? ` ${className}` : ''}`} data-dir={dir} viewBox={`0 0 ${grid} ${grid}`} aria-hidden="true"
      fill={fill ? 'currentColor' : 'none'} stroke={fill ? undefined : 'currentColor'} strokeWidth={fill ? undefined : WEIGHT[grid]}
      strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

/** Every expand, collapse, next and back control points with this: drawn pointing down, icons.css turns it to its dir. */
export const Caret = ({ dir, size }: Props & { dir: 'up' | 'down' | 'left' | 'right' }) => (
  <Svg grid={10} size={size} className="caret" dir={dir}><path d="M2 3.5 5 6.5 8 3.5" /></Svg>
);

export const Check = ({ size }: Props) => <Svg grid={10} size={size}><path d="M1.8 5.4 4 7.6 8.4 2.6" /></Svg>;

const DOT = <circle cx="5" cy="5" r=".9" fill="currentColor" stroke="none" />;
const MARK = {
  ok: <path d="M1.8 5.4 4 7.6 8.4 2.6" />,
  fail: <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />,
  warn: <><path d="M5 1.8v3.6" /><circle cx="5" cy="7.9" r=".9" fill="currentColor" stroke="none" /></>,
  todo: <circle cx="5" cy="5" r="2.6" />,
  start: DOT,
  skip: <path d="M3 5h4" />,
};
export type MarkStatus = keyof typeof MARK;

/** How a step stands, in every list of steps: done, failed, wanting a look, still to come, started or skipped. */
export const Mark = ({ status, size }: Props & { status: MarkStatus }) => <Svg grid={10} size={size}>{MARK[status]}</Svg>;

export const Close = ({ size }: Props) => <Svg grid={12} size={size}><path d="M3 3l6 6M9 3 3 9" /></Svg>;

export const More = ({ size }: Props) => (
  <Svg grid={12} size={size} fill><circle cx="2.5" cy="6" r=".95" /><circle cx="6" cy="6" r=".95" /><circle cx="9.5" cy="6" r=".95" /></Svg>
);

export const Grip = ({ size }: Props) => (
  <Svg grid={12} size={size} fill>
    <circle cx="4" cy="2" r="1.2" /><circle cx="8" cy="2" r="1.2" /><circle cx="4" cy="6" r="1.2" />
    <circle cx="8" cy="6" r="1.2" /><circle cx="4" cy="10" r="1.2" /><circle cx="8" cy="10" r="1.2" />
  </Svg>
);

export const Star = ({ on, size }: Props & { on: boolean }) => (
  <Svg grid={12} size={size}><path fill={on ? 'currentColor' : 'none'} d="M6 1.4 7.18 4.78l3.58.08-2.86 2.16 1.04 3.43L6 8.4l-2.94 2.05 1.04-3.43-2.86-2.16 3.58-.08z" /></Svg>
);

// two arrows passing: the scribe placing robots
export const Place = ({ size }: Props) => <Svg grid={12} size={size}><path d="M1.5 4h7.5M7 1.8 9.5 4 7 6.2M10.5 8H3M5 5.8 2.5 8 5 10.2" /></Svg>;

export const Pr = ({ size }: Props) => (
  <Svg grid={12} size={size}>
    <circle cx="3" cy="2.7" r="1.35" /><circle cx="3" cy="9.3" r="1.35" /><circle cx="9" cy="9.3" r="1.35" />
    <path d="M3 4.1v3.8M9 7.9V5.3c0-.9-.6-1.5-1.5-1.5H5.4M6.7 2.3 5.3 3.8l1.4 1.5" />
  </Svg>
);

export const Bot = ({ size }: Props) => (
  <Svg grid={12} size={size} fill>
    <path fillRule="evenodd" d="M3.4 3.6h5.2a1.8 1.8 0 0 1 1.8 1.8v3.4a1.8 1.8 0 0 1-1.8 1.8H3.4a1.8 1.8 0 0 1-1.8-1.8V5.4a1.8 1.8 0 0 1 1.8-1.8zM3.7 7a1 1 0 1 0 2 0a1 1 0 1 0-2 0zM6.3 7a1 1 0 1 0 2 0a1 1 0 1 0-2 0zM5.45 3.6V2.3h1.1v1.3zM5 1.35a1 1 0 1 0 2 0a1 1 0 1 0-2 0zM.5 6h1.1v2.2H.5zM10.4 6h1.1v2.2h-1.1z" />
  </Svg>
);

export const Eye = ({ size }: Props) => (
  <Svg grid={12} size={size}>
    <path d="M.9 6C2.2 3.7 3.9 2.6 6 2.6s3.8 1.1 5.1 3.4C9.8 8.3 8.1 9.4 6 9.4S2.2 8.3.9 6z" />
    <circle cx="6" cy="6" r="1.65" fill="currentColor" stroke="none" />
  </Svg>
);

export const Hand = ({ size }: Props) => (
  <Svg grid={12} size={size}>
    <path d="M4 6.6V2.7a.8.8 0 0 1 1.6 0V6M5.6 5.6V1.9a.8.8 0 0 1 1.6 0v3.7M7.2 5.6V2.7a.8.8 0 0 1 1.6 0V7c0 2.2-1.4 3.6-3.3 3.6-1.2 0-2-.6-2.6-1.6L1.8 7.4a.75.75 0 0 1 1.2-.9L4 7.5" />
  </Svg>
);

/** A worker's rack: the machine a robot runs on, or moves to. */
export const Machine = ({ size }: Props) => (
  <Svg grid={12} size={size}>
    <rect x="1.6" y="1.7" width="8.8" height="3.6" rx="1.1" /><rect x="1.6" y="6.7" width="8.8" height="3.6" rx="1.1" />
    <circle cx="3.9" cy="3.5" r=".6" fill="currentColor" stroke="none" /><circle cx="3.9" cy="8.5" r=".6" fill="currentColor" stroke="none" />
  </Svg>
);

export const Mac = ({ size }: Props) => <Svg grid={12} size={size}><rect x="2.3" y="2.3" width="7.4" height="5.2" rx=".9" /><path d="M1.1 9.4h9.8" /></Svg>;

export const Moon = ({ size }: Props) => <Svg grid={12} size={size}><path d="M10 7.25A4 4 0 0 1 4.75 2a4 4 0 1 0 5.25 5.25Z" /></Svg>;

export const Phone = ({ size }: Props) => <Svg grid={24} size={size}><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></Svg>;

export const Meter = ({ size }: Props) => (
  <Svg grid={24} size={size}><circle cx="12" cy="12" r="9" /><path d="M12 12V3a9 9 0 0 1 9 9Z" fill="currentColor" stroke="none" /></Svg>
);

export const Pulse = ({ size }: Props) => <Svg grid={24} size={size}><path d="M3 12h4l2.5-6 5 12 2.5-6h4" /></Svg>;

export const Feedback = ({ size }: Props) => <Svg grid={24} size={size}><path d="M4 5h16v11H10l-5 4v-4H4z" /></Svg>;

export const Gear = ({ size }: Props) => (
  <Svg grid={24} size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Svg>
);

export const Update = ({ size }: Props) => (
  <Svg grid={24} size={size}><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" /></Svg>
);

// a pane divided in two, the half it gains filled in
export const Split = ({ size }: Props) => (
  <Svg grid={24} size={size}>
    <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" /><rect x="13" y="7" width="6.5" height="10" rx="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

// the half a pane gives back, crossed out
export const Unsplit = ({ side, size }: Props & { side: 'left' | 'right' }) => {
  const x = side === 'left' ? 4.5 : 14;
  return (
    <Svg grid={24} size={size}>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" /><path d={`M12 4.5v15M${x} 9l5.5 6M${x + 5.5} 9l-5.5 6`} />
    </Svg>
  );
};
