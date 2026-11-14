import { Command, Option } from 'commander';
import type { Client } from '../client.js';
import type { There } from '../commands/host.js';
import { contextOptions } from './context.js';
import { lazy } from './lazy.js';

const REPORT_HELP = 'hear back when it is done, blocked or stops: svalld types a line into this robot';

/** `there`: how a machine is reached from this Mac's terminal, for the commands a move's list names. */
export function robotCommands(connect: () => Promise<Client>, json: () => boolean, there: (machine: string) => There | Promise<There>): Command {
  const run = lazy(() => import('../commands/robot.js').then((m) => m.robotActions(connect, json, there)));
  const cmd = new Command('robot').alias('char').description('manage robots');

  cmd.command('list').description("list every robot, or one island's").option('--island <id>').option('--started-by <id>', 'only the robots that robot started')
    .action(run('list'));

  cmd.command('new').description('make a robot: a terminal on an island')
    .requiredOption('--island <id>').requiredOption('--cwd <path>')
    .option('--name <name>')
    .addOption(new Option('--agent [name]', 'start claude, codex or opencode in its terminal; without a name, the main agent').conflicts(['claude', 'codex', 'opencode', 'command']))
    .addOption(new Option('--claude', 'the same as --agent claude').conflicts(['codex', 'opencode', 'command']))
    .addOption(new Option('--codex', 'the same as --agent codex').conflicts(['opencode', 'command']))
    .addOption(new Option('--opencode', 'the same as --agent opencode').conflicts('command'))
    .option('--command <cmd>').option('--cell <x,y>')
    .option('--run <text>', 'type text and Enter once the agent has started; starts the main agent unless --agent or --command says otherwise; exits 2 when it could not be sent')
    .option('--agent-profile <name>', 'a role from the fleet\'s agent-profiles folder, e.g. reviewer')
    .option('--report', `with --run, ${REPORT_HELP}`)
    .addHelpText('after', `
Handing work to a new robot:
  svall robot new --island <id> --cwd <path> --name "<name>" --run "<prompt>" --report
  - In a git repo, a robot is told to start in a new worktree unless Settings turns that off; --cwd can name a worktree whose branch is the work and no other agent is in.
  - The prompt is all it knows: goal, paths, links, what done looks like.
  - Names: at most 24 characters, lower case: PR or ticket id, area, task, one or two words each: "#472 auth review", not "#472 deep review".
  - New island: svall island create "<name>" --description "<one line>".
  - --report: svalld types "[svall] <name> (<id>) …" into your prompt line when it is done, blocked or stops, so neither of you waits or polls. Closing it is the user's call.
  - Check its work: svall robot read <id> --transcript, and its cwd and branch in svall status --json.
  - Message it, or any robot: svall robot send <id> "<text>" [--report]; it answers the same way. Its final message in full: svall robot read <id> --last.
  - Write ids out: a command holding $SVALL_ROBOT_ID asks the user for permission.`)
    .action(run('new'));

  cmd.command('move <id>').description('move a robot to another island or cell, or to run on another machine; a refused move exits 2')
    .option('--island <id>').option('--cell <x,y>', 'omit it and the daemon picks a free cell')
    .addOption(new Option('--machine <name>', 'a machine under Machines, or local for this machine; prints what travels, then moves it').conflicts(['island', 'cell']))
    .addOption(new Option('--interrupt-after <duration>', 'interrupt what still runs after this long, e.g. 30s or 0').conflicts('island'))
    .addOption(new Option('--carry <file>', 'take a credential file such as .env along; repeatable').argParser((v: string, acc: string[] = []) => [...acc, v]).conflicts('island'))
    .addOption(new Option('--own-worktree', 'on a main checkout, move into a new worktree of its own at HEAD; the checkout keeps its changes').conflicts(['island', 'carry']))
    .addOption(new Option('--retry', 'run on the move the robot is in, from the step it stopped at').conflicts(['island', 'cell', 'machine', 'carry', 'interruptAfter', 'ownWorktree']))
    .action(run('move'));

  cmd.command('run <id> <text...>').description("type text into a robot's terminal, then Enter; prints delivered or queued, exits 2 when refused").option('--no-enter', 'leave the text in the prompt line, where runs after it queue until it is sent or cleared').option('--term <n>', 'terminal to type into: 1 (default) or 2')
    .action(run('run'));

  cmd.command('send <id> <text...>').description('message a robot as this one, which can answer the same way; prints delivered, queued or held, exits 2 when refused')
    .option('--report', REPORT_HELP)
    .action(run('send'));

  cmd.command('read <id>').description("print the end of a robot's screen, or of its transcript, or its agent's last answer").option('--transcript')
    .addOption(new Option('--last', "the final message of the agent's newest turn, in full").conflicts('transcript'))
    .option('--lines <n>', 'screen lines, or turns with --transcript', '50').option('--term <n>', 'terminal to read: 1 (default) or 2')
    .action(run('read'));

  cmd.command('wait <id>').description('wait for a status; exits 0 on a match, 2 on timeout, 3 when the robot has no terminal (deleted or dormant)').requiredOption('--until <statuses>').option('--timeout <seconds>', '', '600').option('--term <n>', 'terminal to wait on: 1 (default) or 2')
    .action(run('wait'));

  contextOptions(cmd.command('update <id>').description("change a robot's name, note, island, context, instructions or agent profile")
    .option('--name <n>').option('--note <n>').option('--note-file <path>', 'read the note from a file, for text a shell would mangle')
    .option('--island <id>').option('--agent-profile <name>', 'a role from the fleet\'s agent-profiles folder; \'\' clears it'))
    .action(run('update'));

  cmd.command('show <id>').description('print the brief the agent gets').action(run('show'));

  cmd.command('seen <id>').description("mark a robot's last turn seen: done turns idle").action(run('seen'));

  cmd.command('revive <id>').description("resume a dormant robot's session in a new terminal")
    .option('--fresh', "start a new session instead, told what the one that could not resume held; that session's files stay")
    .option('--term <n>', 'with --fresh, the terminal: 1 (default) or 2')
    .action(run('revive'));

  cmd.command('close <id>').description('delete a robot, its terminal and its docs').action(run('close'));

  return cmd;
}
