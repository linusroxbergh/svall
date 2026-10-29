import { describe, expect, it } from 'vitest';
import { CLIP, outliner } from '../src/retro/outline.js';
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
  awsSession: 'AS' + 'IA' + 'IOSFODNN7EXAMPLE',
  google: 'AI' + 'za' + 'S'.repeat(35),
  googleOauth: 'ya' + '29.' + 'a0AfH6SMB'.repeat(4),
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9.' + 'ey' + 'JzdWIiOiIxIn0.' + 's1gn4tur3_-x'.repeat(2),
  stripe: 'sk' + '_live_' + 'Ab12'.repeat(6),
  stripeTest: 'sk' + '_test_' + 'Ab12'.repeat(6),
  stripeRestricted: 'rk' + '_live_' + 'Cd34'.repeat(6),
  webhook: 'wh' + 'sec_' + 'MfKQ9r8GKYqrTwjU'.repeat(2),
  npm: 'np' + 'm_' + 'E5f6'.repeat(9),
  gitlab: 'gl' + 'pat-' + 'G7h8'.repeat(5),
  huggingface: 'hf' + '_' + 'Jk9L'.repeat(9),
  slackWebhook: 'hooks' + '.slack.com/services/' + 'T0AB12CD3/B0EF45GH6/' + 'x'.repeat(24),
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
    const flags = 'mkdir -p dir && ssh -p 22 h && docker run -p 8080:80 x && git push -u origin main && mysql -u root -p\nset the Cookie: header';
    expect(redact(flags)).toBe(flags);
  });

  it('masks credentials in headers, URLs, JSON and flags, whatever their case', () => {
    expect(redact('curl -H "Authorization: Bearer abcdef123456"')).toBe('curl -H "Authorization: Bearer [redacted]"');
    expect(redact("curl -H 'authorization: basic dXNlcjpwdw=='")).toBe("curl -H 'authorization: basic [redacted]'");
    expect(redact('curl -H "Authorization: Token 9944b0919c62bcf9418ad846dd0e4bbd"')).toBe('curl -H "Authorization: Token [redacted]"');
    expect(redact('Authorization: Bot MTk4NjIy.Cl2FMQ.ZnCjm1XV')).toBe('Authorization: Bot [redacted]');
    expect(redact('Authorization: Digest a1b2c3')).toBe('Authorization: Digest [redacted]');
    expect(redact('postgres://admin:S3cretPassw0rd@db/x')).toBe('postgres://admin:[redacted]@db/x');
    expect(redact('api_key = "abc123"')).toBe('api_key = [redacted]');
    expect(redact('{"apiKey":"abc123","n":1}')).toBe('{"apiKey":[redacted],"n":1}');
    expect(redact('password: hunter2')).toBe('password: [redacted]');
    expect(redact('db_password=hunter2 --password=hunter3')).toBe('db_password=[redacted] --password=[redacted]');
    expect(redact('X-Auth-Token: t0k3n')).toBe('X-Auth-Token: [redacted]');
    // JSON text a Codex call's arguments arrive as, its newlines escaped
    expect(redact('{"cmd":"cat > .env <<EOF\\nPORT=1\\nSESSION_SECRET=zzz\\nEOF"}')).toBe('{"cmd":"cat > .env <<EOF\\nPORT=1\\nSESSION_SECRET=[redacted]\\nEOF"}');
    expect(redact(`{"cmd":"cat > .npmrc <<EOF\\n${secrets.github}\\nEOF"}`)).toBe('{"cmd":"cat > .npmrc <<EOF\\n[redacted]\\nEOF"}');
  });

  it('masks a secret given after a space, to a flag, a client or a header', () => {
    expect(redact('gh auth login --token s3cr3t')).toBe('gh auth login --token [redacted]');
    expect(redact('deploy --password "hunter 2" --verbose')).toBe('deploy --password [redacted] --verbose');
    expect(redact('mysql -u root -p hunter2 app')).toBe('mysql -u root -p [redacted] app');
    expect(redact('mysqldump -uroot -phunter2 app')).toBe('mysqldump -uroot -p[redacted] app');
    expect(redact('sshpass -p hunter2 ssh h')).toBe('sshpass -p [redacted] ssh h');
    expect(redact('curl -u admin:hunter2 https://x')).toBe('curl -u admin:[redacted] https://x');
    expect(redact('redis://:hunter2@cache:6379/0')).toBe('redis://:[redacted]@cache:6379/0');
    expect(redact('curl -H "Cookie: session=abc; theme=dark" https://x')).toBe('curl -H "Cookie: [redacted]" https://x');
    expect(redact(`curl https://${secrets.slackWebhook} -d x`)).toBe('curl https://[redacted] -d x');
  });

  it('redacts 200 KB of repeated word parts in well under a second', () => {
    for (const part of ['a-', 'key_', 'eyJa-', '.-u', 'mysql-']) {
      const t = performance.now();
      redact(part.repeat(100_000).slice(0, 200_000));
      expect(performance.now() - t, part).toBeLessThan(500);
    }
  });
});

describe('the outliner', () => {
  it('masks a .env line in a tool input before JSON escapes its newline, and a secret the clip would cut', () => {
    const o = outliner();
    o.tool(1, 1, 'Write', { file_path: '.env', content: 'PORT=1\nOPENAI_API_KEY=abcdefsecretvalue123\nDB_PASSWORD=hunter2' });
    o.tool(2, 2, 'exec_command', '{"cmd":"cat > .env <<EOF\\nSESSION_SECRET=zzz\\nEOF"}');
    const long = `API_KEY="${'Zq8xLm3Pv7'.repeat(200)}"`;
    o.said(3, 3, long);
    o.prompt(4, 4, long);
    o.error(5, 5, `${'e'.repeat(250)} TOKEN="${'s'.repeat(100)}"`);
    o.ran(undefined, 6, 6, `${'c'.repeat(250)} TOKEN="${'s'.repeat(100)}"`, { failed: true });
    const { turns, commands } = o.outline({ agent: 'claude', session: 's', file: 'f' });
    expect(turns[0].text).toBe('Write {"file_path":".env","content":"PORT=1\\nOPENAI_API_KEY=[redacted]\\nDB_PASSWORD=[redacted]"}');
    expect(turns[1].text).toBe('exec_command {"cmd":"cat > .env <<EOF\\nSESSION_SECRET=[redacted]\\nEOF"}');
    for (const t of turns.slice(2)) expect(t.text).not.toMatch(/Zq8x|sss/);
    expect(turns[2].text).toBe('API_KEY=[redacted]');
    expect(commands[0].text).not.toContain('sss');
    expect(turns[4].text.length).toBeLessThanOrEqual(CLIP.error);
  });
});
