#!/usr/bin/env node
// sync.mjs — 本机运行时 → 本仓库（维护者日常开发后同步改动）
//
// 数据源（2026-10-18 改版：旧 dev-default-plugins 市场已删除，本工具曾整体静默失效）：
//   已安装插件缓存 e2e-suite@e2e-suite —— 读 installed_plugins.json 的 installPath，
//   版本目录变化自动跟随，不再写死路径。
// 方向：运行时较新 → 回灌仓库；仓库权威件（plugin.json / mcp / 清单）永不反向覆盖。
//
// 为什么不读 ~/.zcode/skills/：插件整包自带全部技能，用户级副本是旧版 install 的遗留
// （现需 --legacy-skills 才写）。把它当数据源会把旧副本回灌进仓库，覆盖插件里较新的实现。
// 仅当 ~/.zcode/skills/ 下存在、且插件缓存不可用时，才退回读它（见 FALLBACK_SKILLS）。
//
// 安全阀：默认**只报告差异不写入**——本机运行时常常落后于仓库，盲目回灌会把仓库里
// 刚改的实现静默覆盖。确认运行时才是较新的一方后，加 --force 才真正覆盖。
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

// 家族成员（带契约块的成员 + 总控）；新增成员时在此登记
const FAMILY_SKILLS = [
  'api-contract-diff', 'blackbox-e2e-test', 'canary-bootstrap', 'canary-calibration',
  'e2e-env-setup', 'frontend-backend-e2e', 'harness-scaffold', 'negative-path-test',
  'perf-probe', 'persistence-boundary-test', 'report-render', 'streaming-channel-test',
  'test-case-design', 'test-namespace', 'tool-config-guide', 'ux-acceptance-test', 'visual-design-review',
  'visual-regression', 'whitebox-suite',
];
// 门禁自带技能（住在插件缓存，不在 ~/.zcode/skills）
const GATE_SKILLS = ['gate-guide', 'gate-preflight', 'tdd-loop'];
const PKG_DST = path.join(REPO, 'e2e-suite');

// 已安装插件的实际路径：从 installed_plugins.json 解析，版本升级后不用改这个文件
function installedPluginRoot(idWanted) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ZCODE, 'cli/plugins/installed_plugins.json'), 'utf8'));
    const e = (j.plugins || []).find(p => p.id === idWanted);
    if (e && e.installPath && fs.existsSync(e.installPath)) return e.installPath;
  } catch {}
  // 退回：扫缓存目录取最高 semver
  const root = path.join(ZCODE, 'cli/plugins/cache/e2e-suite/e2e-suite');
  if (!fs.existsSync(root)) return null;
  const vers = fs.readdirSync(root).filter(d => /^\d+\.\d+\.\d+$/.test(d)).sort();
  return vers.length ? path.join(root, vers[vers.length - 1]) : null;
}
const PLUGIN_SRC = installedPluginRoot('e2e-suite@e2e-suite');

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
        if (DRY || !FORCE) { console.log(`  DIFF  ${path.relative(REPO, d)}（运行时与仓库不同${FORCE ? '' : '，未写入；确认要回灌请加 --force'}）`); n++; }
        else { fs.copyFileSync(s, d); n++; }
      }
    }
  }
  return n;
}

let changed = 0;
if (!PLUGIN_SRC) {
  // 退回路径：插件缓存不可用时，才把 ~/.zcode/skills 当数据源（旧宿主/旧安装遗留）
  console.log('（未找到插件缓存，退回 ~/.zcode/skills 作为技能数据源）');
  for (const s of FAMILY_SKILLS) {
    const src = path.join(ZCODE, 'skills', s);
    if (!fs.existsSync(src)) { console.log(`SKIP  ${s}（~/.zcode/skills 下不存在）`); continue; }
    const n = copyTree(src, path.join(PKG_DST, 'skills', s));
    if (n) { console.log(`SYNC  ${s}（${n} 个文件有差异）`); changed += n; }
  }
} else {
  console.log(`（数据源：${PLUGIN_SRC}）`);
  // 插件缓存是整包权威源：家族技能与门禁技能一并从它回灌，不再混用用户级副本
  for (const s of [...FAMILY_SKILLS, ...GATE_SKILLS]) {
    const src = path.join(PLUGIN_SRC, 'skills', s);
    if (!fs.existsSync(src)) { console.log(`SKIP  ${s}（插件缓存中不存在）`); continue; }
    const n = copyTree(src, path.join(PKG_DST, 'skills', s));
    if (n) { console.log(`SYNC  ${s}（${n}）`); changed += n; }
  }
  // 引擎与薄壳：只同步 lib/hooks。
  // mcp/、.zcode-plugin/、.mcp.json 不回灌——插件清单与 MCP 以仓库为权威
  // （缓存只是发布物的落地拷贝，仓库里有更新未发布的实现时反向拷贝会静默覆盖）
  for (const sub of ['lib', 'hooks']) {
    const src = path.join(PLUGIN_SRC, sub);
    if (!fs.existsSync(src)) continue;
    const n = copyTree(src, path.join(PKG_DST, sub));
    if (n) { console.log(`SYNC  gate:${sub}（${n}）`); changed += n; }
  }
}
console.log(DRY && changed ? `dry-run：${changed} 个文件有差异`
  : changed ? (FORCE ? `完成：${changed} 个文件已同步（记得 git commit）`
                     : `发现 ${changed} 个差异文件，未写入。确认运行时较新后加 --force 回灌。`)
  : '无差异，仓库已是最新');
