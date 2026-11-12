import { handoff } from './handoff.js';
import { buildProgram } from './program.js';

// what a tool said of the failure, on the error or in a daemon's answer, goes on a line of its own under the sentence
const failed = (e: unknown): never => {
  const { message, raw, data } = e as Error & { raw?: string; data?: { raw?: unknown } };
  const said = raw ?? (typeof data?.raw === 'string' ? data.raw : undefined);
  process.stderr.write(`svall: ${message}\n${said ? `  ${said}\n` : ''}`);
  process.exit(1);
};

const program = buildProgram();
try { handoff(process.argv, program); } catch (e) { failed(e); }

program.parseAsync(process.argv).catch(failed);
