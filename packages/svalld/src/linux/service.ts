import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** How this module reaches systemd; a test passes its own. Argv only, never a shell. */
export type Run = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export const realRun: Run = (cmd, args) => exec(cmd, args, { timeout: 30_000 });

export type SystemdErrorCode = 'no_systemd' | 'unit_failed';

export class SystemdError extends Error {
  constructor(readonly code: SystemdErrorCode, message: string, readonly stderr: string) {
    super(message);
    this.name = 'SystemdError';
  }
}

export type UnitStatus = { unit: string; load: string; active: string; sub: string; state: string };

const PROPERTIES = ['LoadState', 'ActiveState', 'SubState', 'UnitFileState'];
// a shell that never had a login session has no user bus, so systemctl --user cannot reach systemd
const NO_BUS = /Failed to connect to (the )?bus|DBUS_SESSION_BUS_ADDRESS/i;
const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';

const failed = (cmd: string, e: unknown): SystemdError => {
  const err = e as NodeJS.ErrnoException & { stderr?: string };
  const stderr = err.stderr ?? '';
  if (err.code === 'ENOENT') return new SystemdError('no_systemd', `${cmd} is not installed: this machine has no systemd user services`, stderr);
  if (NO_BUS.test(stderr)) return new SystemdError('no_systemd', `${cmd} found no systemd user session: log in over SSH and enable lingering`, stderr);
  return new SystemdError('unit_failed', firstLine(stderr) || err.message, stderr);
};

async function systemctl(run: Run, args: string[]): Promise<string> {
  try {
    return (await run('systemctl', ['--user', ...args])).stdout;
  } catch (e) {
    const error = failed('systemctl', e);
    throw error.code === 'unit_failed'
      ? new SystemdError('unit_failed', `systemctl --user ${args.join(' ')}: ${error.message}`, error.stderr)
      : error;
  }
}

export const daemonReload = async (run: Run): Promise<void> => { await systemctl(run, ['daemon-reload']); };

export const enableUnit = async (run: Run, unit: string): Promise<void> => { await systemctl(run, ['enable', '--now', unit]); };

export const disableUnit = async (run: Run, unit: string): Promise<void> => { await systemctl(run, ['disable', '--now', unit]); };

export const restartUnit = async (run: Run, unit: string): Promise<void> => { await systemctl(run, ['restart', unit]); };

export const stopUnit = async (run: Run, unit: string): Promise<void> => { await systemctl(run, ['stop', unit]); };

// `systemctl status` exits non-zero for a unit that is merely stopped and prints for a reader;
// `show` answers the same questions in fields, and exits 0 even for a unit systemd never loaded
export async function unitStatus(run: Run, unit: string): Promise<UnitStatus> {
  const out = await systemctl(run, ['show', unit, ...PROPERTIES.map((p) => `--property=${p}`)]);
  const field = (name: string): string => new RegExp(`^${name}=(.*)$`, 'm').exec(out)?.[1] ?? '';
  return { unit, load: field('LoadState'), active: field('ActiveState'), sub: field('SubState'), state: field('UnitFileState') };
}

export type Linger = { user: string; linger: boolean; action: string };

/** Whether the user's services survive logout, and the one command that turns it on. Never run here. */
export async function lingerState(run: Run, user: string): Promise<Linger> {
  const action = `loginctl enable-linger ${user}`;
  try {
    const { stdout } = await run('loginctl', ['show-user', user, '--property=Linger']);
    return { user, linger: /^Linger=yes$/m.test(stdout.trim()), action };
  } catch (e) {
    const error = failed('loginctl', e);
    if (error.code === 'no_systemd') throw error;
    // loginctl refuses a user it has never seen a session for, which is lingering off
    return { user, linger: false, action };
  }
}
