import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keys), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return keys;
}
