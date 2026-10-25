import { handoff } from './handoff.js';
import { buildProgram } from './program.js';

const program = buildProgram();
try { handoff(process.argv, program); } catch (e) { process.stderr.write(`svall: ${(e as Error).message}\n`); process.exit(1); }

program.parseAsync(process.argv).catch((e: Error) => {
  process.stderr.write(`svall: ${e.message}\n`);
  process.exit(1);
});
