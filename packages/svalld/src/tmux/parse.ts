type ControlLine =
  | { type: 'output'; paneId: string; data: Buffer }
  | { type: 'begin' | 'end' | 'error' }
  | { type: 'window-close'; windowId: string }
  | { type: 'pause' | 'continue'; paneId: string }
  | { type: 'exit'; reason: string }
  | { type: 'other'; raw: string };

const OCTAL = /^[0-7]{3}$/;

export function unescapeOutput(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && OCTAL.test(s.slice(i + 1, i + 4))) {
      out.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

function splitFirst(s: string): [string, string] {
  const i = s.indexOf(' ');
  return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

export function parseLine(line: string): ControlLine {
  if (!line.startsWith('%')) return { type: 'other', raw: line };
  const [tag, rest] = splitFirst(line);
  switch (tag) {
    case '%output': {
      const [paneId, data] = splitFirst(rest);
      return { type: 'output', paneId, data: unescapeOutput(data) };
    }
    case '%extended-output': {
      const [paneId, tail] = splitFirst(rest);
      const sep = tail.indexOf(' : ');
      return { type: 'output', paneId, data: unescapeOutput(sep === -1 ? '' : tail.slice(sep + 3)) };
    }
    case '%begin': return { type: 'begin' };
    case '%end': return { type: 'end' };
    case '%error': return { type: 'error' };
    case '%window-close':
    case '%unlinked-window-close': return { type: 'window-close', windowId: splitFirst(rest)[0] };
    case '%pause': return { type: 'pause', paneId: rest };
    case '%continue': return { type: 'continue', paneId: rest };
    case '%exit': return { type: 'exit', reason: rest };
    default: return { type: 'other', raw: line };
  }
}
