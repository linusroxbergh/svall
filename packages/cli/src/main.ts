import { buildProgram } from './program.js';

buildProgram().parseAsync(process.argv).catch((e: Error) => {
  process.stderr.write(`svall: ${e.message}\n`);
  process.exit(1);
});
