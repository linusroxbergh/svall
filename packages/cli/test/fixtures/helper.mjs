// A stand-in for the helper a launcher starts: it says how it was started, then listens on the
// socket it was told of, or fails before it does.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const args = process.argv.slice(2);
let stdin = 'open';
try { fs.fstatSync(0); stdin = fs.readFileSync(0).length === 0 ? 'closed' : 'open'; } catch { stdin = 'closed'; }
const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]).toString().trim());
process.stderr.write(`${JSON.stringify({ args, pgid, stdin })}\n`);
if (process.env.HELPER_IDLE) {
  // starts and never listens, then gives up
  setTimeout(() => process.exit(1), 1500);
} else if (process.env.HELPER_FAIL) {
  process.stderr.write('this fleet cannot be handed over from here\n');
  process.exit(1);
} else if (process.env.HELPER_RESULT) {
  // listens, runs and ends between two looks at its socket: only its events file says how the run ended
  const changed = { event: 'handover.changed', data: { phase: 'begin' } };
  fs.writeFileSync(process.env.HELPER_EVENTS, `${JSON.stringify(changed)}\n${JSON.stringify({ event: 'handover.result', data: JSON.parse(process.env.HELPER_RESULT) })}\n`);
  process.exit(0);
}
if (!process.env.HELPER_IDLE) {
  const server = net.createServer(() => {});
  server.listen(process.env.HELPER_SOCKET, () => {
    // a helper says it holds the lock by its pid, beside the socket
    if (process.env.HELPER_LOCK) fs.writeFileSync(process.env.HELPER_LOCK, `${process.pid}\n`);
    process.stderr.write('helper up\n');
  });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
}
