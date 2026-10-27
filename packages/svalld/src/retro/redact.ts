// tokens by their shape, and a private key whole, or to the end of a text clipped inside it
const TOKENS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[\w-]{8,}/g,
  /\bsk-[\w-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_\w{16,}/g,
  /\bxox[abposr]-[\w-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[\w-]{35}/g,
  /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g,
];
// a `NAME=value` whose name reads as a credential, in a .env line, an export or inline before a command, quoted or not
const ASSIGNED = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS|AUTH)[A-Z0-9_]*[ \t]*=[ \t]*)(\\?"[^"\n]*"|\\?'[^'\n]*'|[^\s"'`\\]+)/g;

/** `text` with each secret it holds replaced by `[redacted]`; an assignment keeps its name. */
export function redact(text: string): string {
  return TOKENS.reduce((s, re) => s.replace(re, '[redacted]'), text).replace(ASSIGNED, '$1[redacted]');
}
