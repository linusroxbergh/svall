import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

const ROOT = path.join(import.meta.dirname, '..');
const LIB = path.join(ROOT, 'vendor/ghostty-kit/GhosttyKit.xcframework/macos-arm64/libghostty-fat.a');
const NOTICE = path.join(ROOT, 'apps/desktop/mac/NOTICE');
// what build.sh copies into Contents/Resources from the kit
const SHARE = path.join(ROOT, 'vendor/ghostty-kit/share');

// the component each object file GhosttyKit links comes from, by its name less `.o`
const OBJECTS: Record<string, RegExp> = {
  Ghostty: /^(?:libghostty_zcu|vt|base64|codepoint_width|index_of|ext|zig_macos)$/,
  'Zig compiler-rt': /^compiler_rt$/,
  FreeType: /^(?:autofit|bdf|cff|ft\w+|pcf|pfr|psaux|pshinter|psnames|raster|sdf|sfnt|smooth|svg|truetype|type1|type1cid|type42|winfnt)$/,
  libpng: /^png\w*$/,
  zlib: /^(?:adler32|compress|crc32|deflate|gzclose|gzlib|gzread|gzwrite|infback|inffast|inflate|inftrees|trees|uncompr|zutil)$/,
  Oniguruma: /^(?:ascii|big5|cp1251|euc_\w+|gb18030|iso8859_\d+|koi8_r|onig_init|reg\w+|sjis(?:_prop)?|st|unicode(?:_\w+)?|utf(?:8|16_[bl]e|32_[bl]e))$/,
  glslang: /^(?:attribute|CodeGen|Constant|disassemble|doc|glslang_\w+|GlslangToSpv|InfoSink|Initialize|InReadableOrder|Intermediate|intermOut|IntermTraverse|iomapper|limits|Link|linkValidate|Logger|ossource|parseConst|ParseContextBase|ParseHelper|PoolAlloc|Pp\w*|propagateNoContraction|reflection|RemoveTree|resource_limits_c|ResourceLimits|Scan|ShaderLang|spirv_c_interface|SpirvIntrinsics|SpvBuilder|SpvPostProcess|SymbolTable|Versions)$/,
  'SPIRV-Cross': /^spirv_(?:cfg|cross\w*|glsl|msl|parser)$/,
  simdutf: /^simdutf$/,
  Highway: /^(?:abort|aligned_allocator|bridge|nanobenchmark|per_target|print|targets|timer)$/,
  utfcpp: /^empty$/,
  'GNU gettext (libintl)': /^(?:bindtextdom|compat|dc\w*gettext|dgettext|dngettext|explodename|finddomain|getlocalename_l-unsafe|gettext|hash-string|intl-compat|l10nflist|langprefs|loadmsgcat|localealias|localename(?:-\w+)?|log|ngettext|plural(?:-exp)?|setlocale(?:_null(?:-unlocked)?|-lock)?|textdomain|version)$/,
  'Dear ImGui': /^(?:imgui\w*|dcimgui\w*)$/,
  stb: /^stb$/,
  Wuffs: /^wuffs-v[\d.]+$/,
};

// the component each file the app copies from Ghostty's share comes from, by its path there
const RESOURCES: Record<string, RegExp> = {
  'Ghostty shell integration': /^ghostty\/shell-integration\/(?:bash\/ghostty\.bash|zsh\/[^/]+)$/,
  'bash-preexec': /^ghostty\/shell-integration\/bash\/bash-preexec\.sh$/,
  Ghostty: /^(?:ghostty\/shell-integration\/(?:elvish|fish|nushell)\/.+|terminfo\/.+)$/,
  'iTerm2 Color Schemes': /^ghostty\/themes\/[^/]+$/,
};
const LICENCES: [RegExp, RegExp][] = [
  [/\bGPL|General Public License/, /GPL/],
  [/\bMIT\b/, /MIT/],
  [/\bBSD\b/, /BSD/],
  [/\bApache\b/, /Apache/],
  [/Mozilla Public License|\bMPL\b/, /MPL/],
];

const notice = (): string => fs.readFileSync(NOTICE, 'utf8');
const lineOf = (component: string): string | undefined => notice().split('\n').find((l) => l.startsWith(`${component}  `) || l.startsWith(`${component} (`));

test('the app\'s NOTICE names every component GhosttyKit links, and the build ships it with each licence text it names', () => {
  for (const component of Object.keys(OBJECTS)) expect(notice(), component).toMatch(new RegExp(`^${component.replace(/[()]/g, '\\$&')}  `, 'm'));
  const build = fs.readFileSync(path.join(ROOT, 'apps/desktop/mac/build.sh'), 'utf8');
  const texts = [...notice().matchAll(/\b(LICENSE\.[\w.-]+)/g)].map((m) => m[1]);
  expect(texts).toEqual(expect.arrayContaining(['LICENSE.ghostty', 'LICENSE.gpl-3.0', 'LICENSE.bash-preexec']));
  for (const text of new Set(texts)) {
    expect(fs.existsSync(path.join(ROOT, 'apps/desktop/mac', text)), text).toBe(true);
    expect(build, text).toMatch(new RegExp(`cp "\\$MAC/NOTICE"[^\\n]* "\\$MAC/${text.replace(/\./g, '\\.')}"[^\\n]* "\\$APP/Contents/Resources/Licenses/"`));
  }
});

test('the release build keeps those texts beside the licences it collects, in the one Licenses folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-app-notice-'));
  try {
    const collected = path.join(dir, 'apps/desktop/mac/build/licenses');
    fs.mkdirSync(collected, { recursive: true });
    fs.writeFileSync(path.join(collected, 'node.txt'), 'node');
    // build.sh's copy, then app-build.sh's, as each writes the app's licences
    const copies = ['apps/desktop/mac/build.sh', 'scripts/app-build.sh']
      .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => /Resources\/licenses/i.test(l)).join('\n'));
    const r = spawnSync('sh', ['-c', `set -eu\nMAC="${path.join(ROOT, 'apps/desktop/mac')}"\nAPP="${dir}/Svall.app"\n${copies.join('\n')}`], { cwd: dir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'Svall.app/Contents/Resources'))).toEqual(['Licenses']);
    expect(fs.readdirSync(path.join(dir, 'Svall.app/Contents/Resources/Licenses')).sort())
      .toEqual(['LICENSE.bash-preexec', 'LICENSE.ghostty', 'LICENSE.gpl-3.0', 'NOTICE', 'node.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(fs.existsSync(SHARE) ? test : test.skip)('every file the app carries from Ghostty\'s share comes from a component the NOTICE names, under each licence its header names', () => {
  const files = (fs.readdirSync(SHARE, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(SHARE, f)).isFile());
  expect(files.length).toBeGreaterThan(100);
  const unnamed: string[] = [];
  const unlicensed: string[] = [];
  for (const file of files) {
    const component = Object.keys(RESOURCES).find((c) => RESOURCES[c].test(file));
    const line = component && lineOf(component);
    if (!line) { unnamed.push(file); continue; }
    const header = fs.readFileSync(path.join(SHARE, file), 'latin1').split('\n').slice(0, 30).join('\n');
    for (const [named, listed] of LICENCES) if (named.test(header) && !listed.test(line)) unlicensed.push(`${file}: ${line}`);
  }
  expect(unnamed).toEqual([]);
  expect(unlicensed).toEqual([]);
});

(fs.existsSync(LIB) ? test : test.skip)('every object file in GhosttyKit comes from a component the NOTICE names', () => {
  const objects = execFileSync('ar', ['t', LIB], { encoding: 'utf8' }).split('\n').filter((o) => o.endsWith('.o')).map((o) => o.slice(0, -2));
  expect(objects.length).toBeGreaterThan(100);
  expect(objects.filter((o) => !Object.values(OBJECTS).some((re) => re.test(o)))).toEqual([]);
});
