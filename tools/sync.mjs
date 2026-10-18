#!/usr/bin/env node
// sync.mjs — 运行时 → 本仓库（维护者日常开发后同步改动）
//
// 方向：~/.zcode/skills/<家族技能> 与 test-gate 插件市场源 复制到仓库单插件
// e2e-suite/skills/。只同步家族成员（清单见 FAMILY_SKILLS）+ 门禁 3 技能，
// 其余技能不碰。
//
// 安全阀（2026-10-18）：默认**只报告差异不写入**——本机运行时常常落后于仓库
// （例如还没 install 新版本），盲目回灌会把仓库里刚改的实现静默覆盖。确认运行时
// 才是较新的一方后，加 --force 才真正覆盖。
// 用法：node tools/sync.mjs [--dry] [--force]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const ZCODE = path.join(HOME, '.zcode');
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

// 家族成员（带契约标记的 17 个 + 总控）；新增成员时在此登记
const FAMILY_SKILLS = [
  'api-contract-diff', 'blackbox-e2e-test', 'canary-bootstrap', 'canary-calibration',
  'e2e-env-setup', 'frontend-backend-e2e', 'harness-scaffold', 'negative-path-test',
  'perf-probe', 'persistence-boundary-test', 'report-render', 'streaming-channel-test',
  'test-case-design', 'tool-config-guide', 'ux-acceptance-test', 'visual-design-review',
  'visual-regression', 'whitebox-suite',
];
// 门禁自带技能（住在插件市场源，不在 ~/.zcode/skills）
const GATE_SKILLS = ['gate-guide', 'gate-preflight', 'tdd-loop'];
const PLUGIN_SRC = path.join(ZCODE, 'cli/plugins/marketplaces/dev-default-plugins/test-gate');
const PKG_DST = path.join(REPO, 'e2e-suite');

function copyTree(src, dst) {
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyTree(s, d);
    else {
      const need = !fs.existsSync(d) ||
        fs.readFileSync(s).compare(fs.readFileSync(d)) !== 0;
      if (need) {
        // 运行时副本可能是旧的（合并前/未部署）：默认只报告，需 --force 才覆盖仓库
        if (DRY || !FORCE) { console.log(`  DIFF  ${path.relative(REPO, d)}（运行时与仓库不同${FORCE ? '' : '，未写入；确认要回灌请加 --force'}）`); n++; }
        else { fs.copyFileSync(s, d); n++; }
      }
    }
  }
  return n;
}

let changed = 0;
for (const s of FAMILY_SKILLS) {
  const src = path.join(ZCODE, 'skills', s);
  if (!fs.existsSync(src)) { console.log(`SKIP  ${s}（运行时不存在）`); continue; }
  const n = copyTree(src, path.join(PKG_DST, 'skills', s));
  if (n) { console.log(`SYNC  ${s}（${n} 个文件有差异）`); changed += n; }
}
for (const s of GATE_SKILLS) {
  const src = path.join(PLUGIN_SRC, 'skills', s);
  if (!fs.existsSync(src)) { console.log(`SKIP  ${s}（插件源不存在）`); continue; }
  const n = copyTree(src, path.join(PKG_DST, 'skills', s));
  if (n) { console.log(`SYNC  gate:${s}（${n}）`); changed += n; }
}
// 门禁引擎/壳（除 skills 与 .zcode-plugin 外的全部）
// 注意：.zcode-plugin/plugin.json 不反向同步——合并插件的清单以仓库为权威
// （名字/版本/描述都已改为 e2e-suite，拷回 test-gate 的会覆盖掉）
// 注意：mcp/server.mjs 不反向同步——本机市场源可能仍是合并前的 test-gate 版本，
// 它没有 family_skills；反向拷贝会把仓库的新实现静默覆盖掉（2026-10-18 实测踩到）。
const SYNC_SUBS = ['lib', 'hooks']
for (const sub of SYNC_SUBS) {
  const src = path.join(PLUGIN_SRC, sub);
  if (!fs.existsSync(src)) continue;
  const n = copyTree(src, path.join(PKG_DST, sub));
  if (n) { console.log(`SYNC  gate:${sub}（${n}）`); changed += n; }
}
const repoMcp = path.join(PKG_DST, 'mcp/server.mjs');
const srcMcp = path.join(PLUGIN_SRC, 'mcp/server.mjs');
if (fs.existsSync(srcMcp) && fs.existsSync(repoMcp)
    && fs.readFileSync(srcMcp).compare(fs.readFileSync(repoMcp)) !== 0) {
  console.log('SKIP  gate:mcp（市场源版本与仓库不同——MCP 以仓库为权威，不反向覆盖）');
}
const mcpJson = path.join(PLUGIN_SRC, '.mcp.json');
if (fs.existsSync(mcpJson)) {
  const dst = path.join(PKG_DST, '.mcp.json');
  const need = !fs.existsSync(dst) || fs.readFileSync(mcpJson).compare(fs.readFileSync(dst)) !== 0;
  if (need) {
    if (DRY || !FORCE) console.log(`  DIFF  e2e-suite/.mcp.json（运行时与仓库不同${FORCE ? '' : '，未写入；确认要回灌请加 --force'}）`);
    else { fs.copyFileSync(mcpJson, dst); console.log('SYNC  gate:.mcp.json'); }
    changed++;
  }
}
console.log(DRY && changed ? `dry-run：${changed} 个文件有差异`
  : changed ? (FORCE ? `完成：${changed} 个文件已同步（记得 git commit）`
                     : `发现 ${changed} 个差异文件，未写入。确认运行时较新后加 --force 回灌。`)
  : '无差异，仓库已是最新');
