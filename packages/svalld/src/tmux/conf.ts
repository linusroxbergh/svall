import type { Config } from '../config.js';

// extended-keys-format, which Shift+Enter depends on, arrived in tmux 3.5
export function tmuxTooOld(version: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(version);
  return !!m && (Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 5));
}

export type TmuxEnv = { platform?: NodeJS.Platform; tmuxVersion?: string };

export function tmuxConfText(config: Config, env: TmuxEnv = {}): string {
  const platform = env.platform ?? process.platform;
  const lines: (string | undefined)[] = [
    'set -s exit-empty off',
    'set -s escape-time 0',
    'set -g prefix None',
    'set -g destroy-unattached off',
    'set -g detach-on-destroy on',
    'set -g default-terminal "xterm-256color"',
    'set -as terminal-features ",xterm-256color:RGB"',
    // tmux passes OSC 8 links on only to a terminal it knows takes them; codex marks its links with nothing else
    'set -as terminal-features "xterm*:hyperlinks"',
    'set -g default-size 120x40',
    'set -g window-size latest',
    'set -g allow-rename off',
    'set -g automatic-rename off',
    'set -g remain-on-exit off',
    'set -g history-limit 20000',
    'set -g status off',
    'set -g mouse on',
    // marking text with the mouse copies it: every copy binding pipes through this command,
    // which only macOS has; elsewhere tmux keeps the selection in its own buffer
    platform === 'darwin' ? 'set -g copy-command "pbcopy"' : undefined,
    // and only through it: tmux's OSC 52 copy would reach Ghostty too, whose clipboard-write = ask would then ask
    'set -s set-clipboard off',
    // a pane that asks for modified keys (Claude Code does) gets Shift+Enter as CSI 13;2u instead of a bare CR
    'set -s extended-keys on',
    // tmux before 3.5 does not know this option and fails source-file on it; only Shift+Enter is lost
    env.tmuxVersion && tmuxTooOld(env.tmuxVersion) ? undefined : 'set -s extended-keys-format csi-u',
  ];
  if (config.shell) lines.push(`set -g default-shell "${config.shell}"`);
  return lines.filter((l) => l !== undefined).join('\n') + '\n';
}
