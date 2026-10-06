// Asks for modified keys the way Claude Code does (modifyOtherKeys 2 and the kitty protocol),
// and, given 'paste' as argv[3], bracketed paste; then records every byte it receives as hex, one chunk per line, to argv[2].
const fs = require('node:fs');
process.stdin.setRawMode(true);
process.stdout.write(`\x1b[>4;2m\x1b[>5u${process.argv[3] === 'paste' ? '\x1b[?2004h' : ''}`);
process.stdin.on('data', (d) => fs.appendFileSync(process.argv[2], d.toString('hex') + '\n'));
