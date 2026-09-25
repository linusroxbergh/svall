import { fileURLToPath } from 'node:url';

// where `archi mobile` builds the phone page, and where archid serves it from
export const MOBILE_DIST = fileURLToPath(new URL('../../../../apps/desktop/web/dist-mobile', import.meta.url));
