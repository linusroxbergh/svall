// A second svall process reaching the same machine: it opens a master, lets go of it, and says which
// control socket it used.
import { SshMaster } from '../../src/controller/ssh.js';

const [destination, socketDir] = process.argv.slice(2);
const master = await SshMaster.open({ destination, socketDir });
await master.close();
process.stdout.write(master.socket);
