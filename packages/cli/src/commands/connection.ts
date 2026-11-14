import { localConnectionInfo } from '../controller/connection.js';
import { printResult } from '../format.js';

export function connectionInfoActions(home: () => string, json: () => boolean) {
  return {
    connectionInfo: () => {
      const info = localConnectionInfo(home());
      printResult(info, json(), () => [
        `fleet    ${info.fleetId}`,
        `machine  ${info.machineId}`,
        `release  ${info.release}`,
        `protocol ${info.protocol}`,
        `endpoint ws://${info.host}:${info.port}`,
        'token    (only in --json, for a controller to read over ssh)',
      ].join('\n'));
    },
  };
}
