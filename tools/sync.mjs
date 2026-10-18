#!/usr/bin/env node
// sync.mjs — 运行时 → 本仓库（维护者日常开发后同步改动）
//
// 方向：~/.zcode/skills/<家族技能> 与 test-gate 插件市场源 复制到仓库。
// 只同步家族成员（清单见 FAMILY_SKILLS），其余技能不碰。
// 用法：node tools/sync.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const ZCODE = path.join(HOME, '.zcode');
const DRY = process.argv.includes('--dry');

// 家族成员（带契约标记的 17 个 + 总控）；新增成员时在此登记
const FAMILY_SKILLS = [
  'api-contract-diff', 'blackbox-e2e-test', 'canary-bootstrap', 'canary-calibration',
  'e2e-env-setup', 'frontend-backend-e2e', 'harness-scaffold', 'negative-path-test',
  'perf-probe', 'persistence-boundary-test', 'report-render', 'streaming-channel-test',
  'test-case-design', 'tool-config-guide', 'ux-acceptance-test', 'visual-design-review',
  'visual-regression', 'whitebox-suite',
];
const PLUGIN_SRC = path.join(ZCODE, 'cli/plugins/marketplaces/dev-default-plugins/test-gate');
const PLUGIN_DST = path.join(REPO, 'test-gate');

function copyTree(src, dst) {
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyTree(s, d);
    else {
      const need = !fs.existsSync(d) ||
        fs.readFileSync(s).compare(fs.readFileSync(d)) !== 0;
      if (need) { if (!DRY) fs.copyFileSync(s, d); n++; }
    }
  }
  return n;
}

let changed = 0;
for (const s of FAMILY_SKILLS) {
  const src = path.join(ZCODE, 'skills', s);
  if (!fs.existsSync(src)) { console.log(`SKIP  ${s}（运行时不存在）`); continue; }
  const n = copyTree(src, path.join(REPO, 'e2e-suite-skills/skills', s));
  if (n) { console.log(`SYNC  ${s}（${n} 个文件有差异）`); changed += n; }
}
if (fs.existsSync(PLUGIN_SRC)) {
  const n = copyTree(PLUGIN_SRC, PLUGIN_DST);
  if (n) { console.log(`SYNC  test-gate（${n} 个文件有差异）`); changed += n; }
}
console.log(DRY && changed ? `dry-run：${changed} 个文件将更新` :
  changed ? `完成：${changed} 个文件已同步（记得 git commit）` : '无差异，仓库已是最新');
