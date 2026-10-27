// a token starts at a word's edge or right after an escaped \n, \r or \t in JSON text
const START = String.raw`(?:\b|(?<=\\[ntr]))`;
// tokens by their shape, and a private key whole, or to the end of a text clipped inside it
const TOKENS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  ...[
    /sk-ant-[\w-]{8,}/,
    /sk-[\w-]{20,}/,
    /[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/,
    /gh[pousr]_[A-Za-z0-9]{16,}/,
    /github_pat_\w{16,}/,
    /glpat-[\w-]{16,}/,
    /npm_[A-Za-z0-9]{20,}/,
    /xox[abposr]-[\w-]{8,}/,
    /(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /AIza[\w-]{35}/,
    /hf_[A-Za-z0-9]{30,}/,
    /ya29\.[\w-]{20,}/,
    /whsec_[A-Za-z0-9+/=]{16,}/,
    /hooks\.slack\.com\/[\w/-]+/,
    // never after a dash, so a long dashed word is read from its start alone
    /(?<!-)eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/,
  ].map((re) => new RegExp(START + re.source, 'g')),
];
// the password in a URL's user:password@, the user empty or not
const USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@"'`]*:)[^\s/@"'`]+@/gi;
// a cookie header's value, to the end of its line or quote
const COOKIE = /\b((?:set-)?cookie\\?["']?[ \t]*:[ \t]*)(\\?"[^"\n]*"|\\?'[^'\n]*'|[^\s=;"'`\\]{1,64}=[^"'`\n\\]*)/gi;
// the value a flag named as a credential takes after a space
const FLAG = /((?<![\w-])--?[a-z0-9-]{0,64}(?:key|token|secret|pass(?:word|wd|phrase)?|auth)[ \t]+)(\\?"[^"\n]*"|\\?'[^'\n]*'|[^\s"'`\\-][^\s"'`\\]*)/gi;
// the password a database client or sshpass takes as -p, joined or not; elsewhere -p is a port or a switch
const DASH_P = /\b((?:mysql|mariadb|mongo|sshpass)[^\n|;&]{0,256}?[ \t]-p[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"'`\\-][^\s"'`\\]*)/g;
// the password in the user:password curl -u takes
const USER = /((?<![\w-])(?:-u|--user)[ \t=]*[^\s:"'`\\]{0,64}:)([^\s"'`\\]+)/gi;
// a name that reads as a credential set with `=` or `:`, in a .env line, an export, a header, JSON or a flag, quoted or not,
// an Authorization header's value read past its scheme; a name starting right after an escaped \n in JSON text keeps the n
const ASSIGNED = /\b([a-z0-9_]{0,64}(?:key|token|secret|pass(?:word|wd|phrase)?|auth(?:orization)?)(?:_[a-z0-9_]{0,64})?\\?["']?[ \t]*[=:][ \t]*(?:(?:bearer|basic|(?<=authorization[ \t]*:[ \t]*)[a-z]+)[ \t]+)?)(\\?"[^"\n]*"|\\?'[^'\n]*'|[^\s"'`\\]+)/gi;

/** `text` with each secret it holds replaced by `[redacted]`; an assignment keeps its name. */
export function redact(text: string): string {
  const tokens = TOKENS.reduce((s, re) => s.replace(re, '[redacted]'), text).replace(USERINFO, '$1[redacted]@');
  return [COOKIE, FLAG, DASH_P, USER, ASSIGNED].reduce((s, re) => s.replace(re, '$1[redacted]'), tokens);
}
