import path from 'node:path';
import { checkFleetConfig } from '../config.js';
import type { Logger } from '../log.js';
import { realPath, type Paths } from '../paths.js';
import { rootIdOf } from '../resources/scan.js';
import { Workspace } from './workspace.js';

/** fleet.json as a root of its own, which no other method knows. A link is read and written where it leads, as `patchConfigFile`
 *  writes one, and one to a key is refused as the key is. */
export function fleetConfigFile(paths: Pick<Paths, 'home' | 'fleetConfig'>, log: Logger, refused: () => string[]) {
  const rootId = rootIdOf(paths.home);
  const at = () => {
    const real = realPath(paths.fleetConfig);
    return { name: path.basename(real), workspace: new Workspace(() => path.dirname(real), log, refused) };
  };
  return {
    rootId,
    read() {
      const { name, workspace } = at();
      return workspace.read(rootId, name);
    },
    // a file the daemon could not start on would leave a far home out of reach of this very editor
    write(text: string, mtimeMs: number, root?: string) {
      checkFleetConfig(text, paths);
      const { name, workspace } = at();
      return workspace.write(rootId, name, text, mtimeMs, root);
    },
  };
}
