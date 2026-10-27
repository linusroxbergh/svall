// tokens by their shape, and a private key whole, or to the end of a text clipped inside it
const TOKENS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[\w-]{8,}/g,
  /\bsk-[\w-]{20,}/g,
  /\b[sr]k_live_[A-Za-z0-9]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_\w{16,}/g,
  /\bglpat-[\w-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bxox[abposr]-[\w-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[\w-]{35}/g,
  /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g,
];
// the password in a URL's user:password@
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:)[^\s/@"'`]+@/gi;
// a name that reads as a credential set with `=` or `:`, in a .env line, an export, a header, JSON or a flag, quoted or not;
// a name starting right after an escaped \n in JSON text keeps the n
const ASSIGNED = /\b([a-z0-9_]*(?:key|token|secret|pass(?:word|wd|phrase)?|auth(?:orization)?)(?:_[a-z0-9_]*)?\\?["']?[ \t]*[=:][ \t]*(?:(?:bearer|basic)[ \t]+)?)(\\?"[^"\n]*"|\\?'[^'\n]*'|[^\s"'`\\]+)/gi;

/** `text` with each secret it holds replaced by `[redacted]`; an assignment keeps its name. */
export function redact(text: string): string {
  return TOKENS.reduce((s, re) => s.replace(re, '[redacted]'), text).replace(USERINFO, '$1[redacted]@').replace(ASSIGNED, '$1[redacted]');
}
