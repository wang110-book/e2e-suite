#!/usr/bin/env node
// bump.mjs — 统一版本号（发版前跑一次，防止漏改导致客户端更新不到）
//
// WHY THIS EXISTS:
//   ZCode 的插件更新是**版本号驱动**的：marketplace.json 里的 version 不变，
//   即使仓库代码变了，`zcode plugins update` 也会回 "already up to date"，
//   已安装缓存按 version 目录固定（cache/<market>/<plugin>/<version>/），不会重拉。
//   版本号散落在 5 个文件里，手工同步必漏——漏了就等于这次更新没人能收到。
//
// 同步范围（这 5 处必须一致）：
//   package.json                                 仓库自身（门禁锚点）
//   marketplace.json                             plugins[0].version
//   .claude-plugin/marketplace.json              plugins[0].version（兼容副本）
//   e2e-suite/.zcode-plugin/plugin.json          插件清单
//   e2e-suite/mcp/server.mjs                     SERVER.version（运行时自报版本）
//
// 刻意不动：README.md / suite-contract.md 里的 "v1.2.0" 是历史叙述，不是当前版本。
//
// 用法：
//   node tools/bump.mjs 1.3.0          # 写入
//   node tools/bump.mjs 1.3.0 --dry    # 只报告
//   node tools/bump.mjs --check        # 只校验五处是否一致（CI 用，不一致 exit 1）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const CHECK = process.argv.includes('--check');
const target = process.argv.slice(2).find(a => !a.startsWith('--'));

const SEMVER = /^\d+\.\d+\.\d+$/;

// 每个条目：文件 + 读/写版本的函数（保持文件原有格式，只替换那一个字段）
const SITES = [
  {
    file: 'package.json',
    read: (j) => j.version,
    write: (j, v) => { j.version = v; return j; },
  },
  {
    file: 'marketplace.json',
    read: (j) => j.plugins?.[0]?.version,
    write: (j, v) => { j.plugins[0].version = v; return j; },
  },
  {
    file: '.claude-plugin/marketplace.json',
    read: (j) => j.plugins?.[0]?.version,
    write: (j, v) => { j.plugins[0].version = v; return j; },
  },
  {
    file: 'e2e-suite/.zcode-plugin/plugin.json',
    read: (j) => j.version,
    write: (j, v) => { j.version = v; return j; },
  },
  {
    file: 'e2e-suite/mcp/server.mjs',
    text: true,
    read: (text) => (text.match(/const SERVER = \{ name: 'e2e-suite', version: '([^']+)' \}/) || [])[1],
    write: (text, v) => text.replace(
      /(const SERVER = \{ name: 'e2e-suite', version: ')[^']+(' \})/,
      `$1${v}$2`),
  },
];

function load(site) {
  const abs = path.join(REPO, site.file);
  const raw = fs.readFileSync(abs, 'utf8');
  return site.text ? { abs, raw, data: raw } : { abs, raw, data: JSON.parse(raw) };
}

// ── --check：只校验一致性 ────────────────────────────────────────────
if (CHECK) {
  const seen = [];
  let ok = true;
  for (const site of SITES) {
    let v;
    try { v = site.read(load(site).data); } catch (e) { console.log(`ERROR  ${site.file}: ${e.message}`); ok = false; continue; }
    seen.push({ file: site.file, v });
    if (!v) { console.log(`MISSING ${site.file} 未找到 version 字段`); ok = false; }
    else console.log(`${String(v).padEnd(8)} ${site.file}`);
  }
  const distinct = [...new Set(seen.map(s => s.v).filter(Boolean))];
  if (distinct.length > 1) {
    console.log(`\n✖ 版本号不一致：${distinct.join(' / ')}`);
    console.log('  跑 `node tools/bump.mjs <version>` 统一。');
    process.exit(1);
  }
  console.log(ok ? `\n✔ 五处版本号一致：${distinct[0]}` : '\n✖ 校验未通过');
  process.exit(ok ? 0 : 1);
}

// ── 写入 ─────────────────────────────────────────────────────────────
if (!target) {
  console.error('usage: node tools/bump.mjs <x.y.z> [--dry]');
  console.error('       node tools/bump.mjs --check');
  process.exit(2);
}
if (!SEMVER.test(target)) {
  console.error(`✖ 版本号必须是 x.y.z 形式（收到 "${target}"）`);
  process.exit(2);
}

let changed = 0;
for (const site of SITES) {
  const { abs, raw, data } = load(site);
  const current = site.read(data);
  if (current === target) { console.log(`SKIP   ${site.file}（已是 ${target}）`); continue; }
  const next = site.write(site.text ? raw : JSON.parse(raw), target);
  const out = site.text ? next : JSON.stringify(next, null, 2) + '\n';
  if (!DRY) fs.writeFileSync(abs, out);
  console.log(`${DRY ? 'WOULD ' : 'BUMP  '} ${site.file}  ${current || '(none)'} → ${target}`);
  changed++;
}
console.log(DRY
  ? `\ndry-run：${changed} 个文件将更新`
  : changed
    ? `\n✔ ${changed} 个文件已更新为 ${target}\n  下一步：git commit && git push，然后客户端跑\n    zcode plugins update e2e-suite@e2e-suite\n  再重启 ZCode 宿主（hooks/MCP 只在启动时加载）。`
    : `\n无变化：五处均已是 ${target}`);
