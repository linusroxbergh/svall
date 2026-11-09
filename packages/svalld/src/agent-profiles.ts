import fs from 'node:fs';
import path from 'node:path';
import { bodyOf, frontmatter } from '@svall/protocol';
import { sha256Hex } from './hash.js';
import { assetDir } from './runtime.js';

// the body rides first in every brief whose robot picks it, and in a change to one; Claude shows only the first 2,000 or so
// characters of hook text past 10,000, and under this cap the whole role fits in them
export const AGENT_PROFILE_MAX = 1500;
// a file this big is over the cap whatever its frontmatter, and is not read into memory to find out
const FILE_MAX = 16 * 1024;
// a file directly in the folder: no path, no hidden file, nothing that could forge a line of the brief
const NAME = /^[^/\\.\x00-\x1f][^/\\\x00-\x1f]*$/;
const BUNDLED = assetDir('agent-profiles');

export type AgentProfile = { name: string; description?: string; body: string };
type AgentProfileRead = AgentProfile | { name: string; error: string };

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

// each starter's sha256 as every release shipped it: an edit to one adds its new sha, so a machine set up before reads as untouched
export const STARTER_SHAS: Readonly<Record<string, readonly string[]>> = {
  'architect.md': ['91fdef9af503c9f9acc1296adddf74efad0ca6e851becab561d15921789f07a1'],
  'debugger.md': ['9ac81c9196d003495786f16390bc150732bb1b749c4be65a68bd048c7986cd00'],
  'explorer.md': ['762a3bcb4b45920fa154203b6876265673c88d32fe07e3d02a3c9a65b7c00c32'],
  'island-leader.md': ['cf85e51f3b54ac4ca164ad81e3804c133850752a3b630f7037d3fe3617a97b23'],
  'planner.md': ['a7b75252a76f2a95cc75a8177a7b368c1a9159465031dc18614ccebfce5d44f2'],
  'reviewer.md': ['68e77aa1cdb002d1b9df419f857813eccd0449c28e8ad715946b80c9884252d9'],
  'verifier.md': ['8fabc63c1088b576c7d54a446547f057bcb273a29f26604d446d654ea2ff262b'],
};

/** Whether `file` holds the bytes of the profile a fleet starts with at `rel`, as any release shipped it. */
export function isStarterProfile(rel: string, file: string, shipped = STARTER_SHAS): boolean {
  try { return Object.hasOwn(shipped, rel) && shipped[rel].includes(sha256Hex(fs.readFileSync(file))); } catch { return false; }
}

/** A fleet's first profiles, copied in only while its folder is not there, so one the user deletes stays deleted. */
export function seedAgentProfiles(dir: string, from = BUNDLED): boolean {
  if (fs.existsSync(dir)) return false;
  fs.cpSync(from, dir, { recursive: true });
  return true;
}
