import { Command } from 'commander';
import { localConnectionInfo } from '../controller/connection.js';
import { printResult } from '../format.js';

export function connectionInfoCommand(home: () => string, json: () => boolean): Command {
  return new Command('connection-info')
    .description('what a controller needs to reach this fleet over a tunnel')
    .action(() => {
      const info = localConnectionInfo(home());
      printResult(info, json(), () => [
        `fleet    ${info.fleetId}`,
        `machine  ${info.machineId}`,
        `release  ${info.release}`,
        `protocol ${info.protocol}`,
        `endpoint ws://${info.host}:${info.port}`,
        'token    (only in --json, for a controller to read over ssh)',
      ].join('\n'));
    });
}
