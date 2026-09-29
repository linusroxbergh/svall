import { fileURLToPath } from 'node:url';

// where `svall mobile` builds the phone page, and where svalld serves it from
export const MOBILE_DIST = fileURLToPath(new URL('../../../../apps/desktop/web/dist-mobile', import.meta.url));
