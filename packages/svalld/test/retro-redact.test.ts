import { describe, expect, it } from 'vitest';
import { redact } from '../src/retro/redact.js';

// built from parts so no whole token sits in the source
const secrets = {
  anthropic: 'sk-' + 'ant-api03-' + 'A1b2'.repeat(10),
  openai: 'sk-' + 'proj-' + 'Z9y8'.repeat(8),
  github: 'gh' + 'p_' + 'Q'.repeat(36),
  githubServer: 'gh' + 's_' + 'R'.repeat(36),
  githubPat: 'github' + '_pat_' + '11ABCDEFG0' + 'h'.repeat(40),
  slack: 'xo' + 'xb-' + '1234-5678-' + 'abcdEFGH',
  aws: 'AK' + 'IA' + 'IOSFODNN7EXAMPLE',
  google: 'AI' + 'za' + 'S'.repeat(35),
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9.' + 'ey' + 'JzdWIiOiIxIn0.' + 's1gn4tur3_-x'.repeat(2),
};

describe('redact', () => {
  it('masks each pattern and leaves prose alone', () => {
    for (const [name, secret] of Object.entries(secrets)) {
      expect(redact(`use ${secret} here`), name).toBe('use [redacted] here');
    }
    const pem = ['-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAA', '-----END OPENSSH ' + 'PRIVATE KEY-----'].join('\n');
    expect(redact(`key:\n${pem}\ndone`)).toBe('key:\n[redacted]\ndone');
    // a block clipped before its end is masked to the end
    expect(redact(`key:\n${pem.slice(0, 50)}`)).toBe('key:\n[redacted]');
    // .env lines keep their names, and a name that is no secret keeps its value
    expect(redact('GITHUB_TOKEN=abc123\nDB_PASSWORD="hunter 2"\nexport API_KEY=\'k\'\nPORT=3000'))
      .toBe('GITHUB_TOKEN=[redacted]\nDB_PASSWORD=[redacted]\nexport API_KEY=[redacted]\nPORT=3000');
    // and inside a tool call's JSON, as an inline assignment
    expect(redact('{"command":"NPM_AUTH_TOKEN=\\"x y\\" npm publish"}')).toBe('{"command":"NPM_AUTH_TOKEN=[redacted] npm publish"}');
    const prose = 'Put the API key in settings and pass the token with --token; see https://github.com/acme/app/pull/4, the task-runner-for-everything-in-this-repo, AKIA alone, and eyJ.';
    expect(redact(prose)).toBe(prose);
  });
});
