#!/usr/bin/env node
// install.mjs — 本仓库 → ZCode 运行时（维护者部署用；普通用户请走插件市场安装）
//
// 部署两件事：
//   1) 家族技能 → ~/.zcode/skills/<name>（总控动态发现依赖它们在此）
//   2) test-gate 插件 → 本地市场源 + 已安装版本缓存（若存在）
// 幂等：内容相同跳过；不同则覆盖（运行时改动请先用 sync.mjs 回仓库）。
// 用法：node tools/install.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZCODE = path.join(os.homedir(), '.zcode');
const DRY = process.argv.includes('--dry');

const SKILLS_SRC = path.join(REPO, 'e2e-suite-skills/skills');
const SKILLS_DST = path.join(ZCODE, 'skills');
const GATE_SRC = path.join(REPO, 'test-gate');
const GATE_MARKET = path.join(ZCODE, 'cli/plugins/marketplaces/dev-default-plugins/test-gate');

function copyTree(src, dst) {
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyTree(s, d);
    else {
      const need = !fs.existsSync(d) || fs.readFileSync(s).compare(fs.readFileSync(d)) !== 0;
      if (need) { if (!DRY) fs.copyFileSync(s, d); n++; }
    }
  }
  return n;
}

// 已安装版本缓存：ZCode 实际加载的是这份，存在才同步
function installedCacheDirs() {
  const root = path.join(ZCODE, 'cli/plugins/cache/dev-default-plugins/test-gate');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(d => /^\d+\.\d+\.\d+$/.test(d))
    .map(d => path.join(root, d));
}

let changed = 0;
for (const e of fs.readdirSync(SKILLS_SRC, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const n = copyTree(path.join(SKILLS_SRC, e.name), path.join(SKILLS_DST, e.name));
  if (n) { console.log(`INSTALL  skills/${e.name}（${n}）`); changed += n; }
}
if (fs.existsSync(GATE_SRC)) {
  const n = copyTree(GATE_SRC, GATE_MARKET);
  if (n) { console.log(`INSTALL  插件市场源 test-gate（${n}）`); changed += n; }
  for (const c of installedCacheDirs()) {
    const m = copyTree(GATE_SRC, c);
    if (m) { console.log(`INSTALL  插件缓存 ${path.basename(c)}（${m}）`); changed += m; }
  }
}
console.log(DRY && changed ? `dry-run：${changed} 个文件将写入运行时` :
  changed ? `完成：${changed} 个文件已部署。重启 ZCode 宿主使技能/插件生效。` :
    '运行时与仓库一致，无需部署');
