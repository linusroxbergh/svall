import fs from 'node:fs';
import webpush from 'web-push';
import { writeJsonAtomic } from '../jsonfile.js';

export type Vapid = { publicKey: string; privateKey: string };

/** The pair every push is signed with. Made once: a new pair orphans every device subscribed under the old one. */
export function readOrCreateVapid(file: string): Vapid {
  if (fs.existsSync(file)) {
    let v: Partial<Vapid>;
    try { v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Vapid>; } catch (e) {
      throw new Error(`${file} unreadable (${String(e)}); move it aside to start over`);
    }
    if (v.publicKey && v.privateKey) { fs.chmodSync(file, 0o600); return { publicKey: v.publicKey, privateKey: v.privateKey }; }
    throw new Error(`${file} is missing publicKey or privateKey; move it aside to start over`);
  }
  const keys = webpush.generateVAPIDKeys();
  writeJsonAtomic(file, keys, { mode: 0o600 });
  return keys;
}
