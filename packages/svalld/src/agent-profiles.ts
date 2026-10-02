import fs from 'node:fs';
import path from 'node:path';
import { bodyOf, frontmatter } from '@svall/protocol';
import { assetDir } from './runtime.js';

// the body rides first in every brief whose character picks it, and in a change to one; Claude shows only the first 2,000 or so
// characters of hook text past 10,000, and under this cap the whole role fits in them
export const AGENT_PROFILE_MAX = 1500;
// a file this big is over the cap whatever its frontmatter, and is not read into memory to find out
const FILE_MAX = 16 * 1024;
// a file directly in the folder: no path, no hidden file, nothing that could forge a line of the brief
const NAME = /^[^/\\.\x00-\x1f][^/\\\x00-\x1f]*$/;
const BUNDLED = assetDir('agent-profiles');

export type AgentProfile = { name: string; description?: string; body: string };
export type AgentProfileRead = AgentProfile | { name: string; error: string };

const isAgentProfileName = (name: string): boolean => NAME.test(name);

/** The profile `name` in `dir`: a plain .md file whose body is text under the cap. A link is refused, since it can lead out of the folder. */
export function readAgentProfile(dir: string, name: string): AgentProfileRead {
  if (!isAgentProfileName(name)) return { name, error: 'is not a profile name' };
  const file = path.join(dir, `${name}.md`);
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(file, { throwIfNoEntry: false }); } catch { st = undefined; }
  if (!st) return { name, error: 'is missing' };
  if (!st.isFile()) return { name, error: 'is not a plain file' };
  if (st.size > FILE_MAX) return { name, error: `is over ${AGENT_PROFILE_MAX} characters` };
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { name, error: `cannot be read: ${(e as NodeJS.ErrnoException).code ?? 'unknown'}` }; }
  if (text.includes('\u0000')) return { name, error: 'is not text' };
  const body = bodyOf(text).trim();
  if (!body) return { name, error: 'has no text' };
  if (body.length > AGENT_PROFILE_MAX) return { name, error: `is over ${AGENT_PROFILE_MAX} characters` };
  const { description } = frontmatter(text);
  return { name, ...(description && { description }), body };
}

/** Every .md file directly in `dir`, by name; one that cannot be used is listed with its error. */
export function listAgentProfiles(dir: string): AgentProfileRead[] {
  let found: fs.Dirent[];
  try { found = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return found.filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => d.name.slice(0, -3))
    .sort((a, b) => a.localeCompare(b)).map((n) => readAgentProfile(dir, n));
}

/** A fleet's first profiles, copied in only while its folder is not there, so one the user deletes stays deleted. */
export function seedAgentProfiles(dir: string, from = BUNDLED): boolean {
  if (fs.existsSync(dir)) return false;
  fs.cpSync(from, dir, { recursive: true });
  return true;
}
