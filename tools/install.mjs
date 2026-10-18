#!/usr/bin/env node
// install.mjs — 本仓库 → 本机 ZCode 运行时（维护者部署用；普通用户走插件市场安装）
//
// 部署镜像 sync.mjs 的来源：
//   1) 家族技能 → ~/.zcode/skills/<name>（总控动态发现依赖它们在此）
//   2) 门禁部分 → 本地市场源 test-gate + 已安装版本缓存（本机 hooks/MCP 实际加载源）
// 幂等：内容相同跳过；不同则覆盖（运行时改动请先用 sync.mjs 回仓库）。
// 用法：node tools/install.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZCODE = path.join(os.homedir(), '.zcode');
const DRY = process.argv.includes('--dry');

const PKG = path.join(REPO, 'e2e-suite');
const SKILLS_DST = path.join(ZCODE, 'skills');
const FAMILY_SKILLS = [
  'api-contract-diff', 'blackbox-e2e-test', 'canary-bootstrap', 'canary-calibration',
  'e2e-env-setup', 'frontend-backend-e2e', 'harness-scaffold', 'negative-path-test',
  'perf-probe', 'persistence-boundary-test', 'report-render', 'streaming-channel-test',
  'test-case-design', 'tool-config-guide', 'ux-acceptance-test', 'visual-design-review',
  'visual-regression', 'whitebox-suite',
];
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
function installedCacheDirs() {
  const root = path.join(ZCODE, 'cli/plugins/cache/dev-default-plugins/test-gate');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(d => /^\d+\.\d+\.\d+$/.test(d))
    .map(d => path.join(root, d));
}

let changed = 0;
for (const s of FAMILY_SKILLS) {
  const src = path.join(PKG, 'skills', s);
  if (!fs.existsSync(src)) { console.log(`SKIP  ${s}（仓库缺）`); continue; }
  const n = copyTree(src, path.join(SKILLS_DST, s));
  if (n) { console.log(`INSTALL  skills/${s}（${n}）`); changed += n; }
}
// 门禁：lib/hooks/mcp + 门禁 3 技能 → 市场源 + 缓存（.zcode-plugin 清单不覆盖，
// 本机仍按 test-gate 身份加载）。家族技能不进市场源（它们装在 ~/.zcode/skills）。
const GATE_SKILLS = ['gate-guide', 'gate-preflight', 'tdd-loop'];
for (const sub of ['lib', 'hooks', 'mcp']) {
  const src = path.join(PKG, sub);
  if (!fs.existsSync(src)) continue;
  const targets = [path.join(GATE_MARKET, sub), ...installedCacheDirs().map(c => path.join(c, sub))];
  for (const dst of targets) {
    const n = copyTree(src, dst);
    if (n) { console.log(`INSTALL  ${path.relative(ZCODE, dst)}（${n}）`); changed += n; }
  }
}
for (const s of GATE_SKILLS) {
  const src = path.join(PKG, 'skills', s);
  if (!fs.existsSync(src)) continue;
  const targets = [path.join(GATE_MARKET, 'skills', s),
                   ...installedCacheDirs().map(c => path.join(c, 'skills', s))];
  for (const dst of targets) {
    const n = copyTree(src, dst);
    if (n) { console.log(`INSTALL  ${path.relative(ZCODE, dst)}（${n}）`); changed += n; }
  }
}
console.log(DRY && changed ? `dry-run：${changed} 个文件将写入运行时` :
  changed ? `完成：${changed} 个文件已部署。重启 ZCode 宿主生效。` :
    '运行时与仓库一致，无需部署');
