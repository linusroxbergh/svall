// Mocked OpenCode 2.0.22 for the integration run, run as `opencode` (argv[0]). It answers the version and login probes
// `host add` and `host doctor` make, as 2.0.22 does, and refuses anything else.
const VERSION = '2.0.22';
const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
// a provider's key from the environment, as `auth list --format json` lists it
if (args[0] === 'auth') {
  process.stdout.write(`${JSON.stringify([{ id: 'opencode', name: 'OpenCode Zen', connections: [{ type: 'env', name: 'OPENCODE_API_KEY' }] }])}\n`);
  process.exit(0);
}
process.stderr.write(`the mocked opencode answers --version and auth, not ${args.join(' ')}\n`);
process.exit(1);
