import { writeDurable } from './handover/durable.js';

// an interrupted write leaves the file it replaces whole, and the temp sits beside it so the rename
// never crosses a filesystem
export function writeJsonAtomic(file: string, value: unknown): void {
  writeDurable(file, value as object, { mode: 0o600 });
}
