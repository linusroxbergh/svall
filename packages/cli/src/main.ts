import { handoff } from './handoff.js';
import { buildProgram } from './program.js';

try { handoff(process.argv); } catch (e) { process.stderr.write(`svall: ${(e as Error).message}\n`); process.exit(1); }

buildProgram().parseAsync(process.argv).catch((e: Error) => {
  process.stderr.write(`svall: ${e.message}\n`);
  process.exit(1);
});
