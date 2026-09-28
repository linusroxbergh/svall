import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const ROOT = path.join(import.meta.dirname, '..');
const LIB = path.join(ROOT, 'vendor/ghostty-kit/GhosttyKit.xcframework/macos-arm64/libghostty-fat.a');
const NOTICE = path.join(ROOT, 'apps/desktop/mac/NOTICE');

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

const notice = (): string => fs.readFileSync(NOTICE, 'utf8');

test('the app\'s NOTICE names every component GhosttyKit links, and the build ships it with Ghostty\'s licence', () => {
  for (const component of Object.keys(OBJECTS)) expect(notice(), component).toMatch(new RegExp(`^${component.replace(/[()]/g, '\\$&')}  `, 'm'));
  const build = fs.readFileSync(path.join(ROOT, 'apps/desktop/mac/build.sh'), 'utf8');
  expect(build).toMatch(/cp "\$MAC\/NOTICE" "\$MAC\/LICENSE\.ghostty" "\$APP\/Contents\/Resources\/licenses\/"/);
});

(fs.existsSync(LIB) ? test : test.skip)('every object file in GhosttyKit comes from a component the NOTICE names', () => {
  const objects = execFileSync('ar', ['t', LIB], { encoding: 'utf8' }).split('\n').filter((o) => o.endsWith('.o')).map((o) => o.slice(0, -2));
  expect(objects.length).toBeGreaterThan(100);
  expect(objects.filter((o) => !Object.values(OBJECTS).some((re) => re.test(o)))).toEqual([]);
});
