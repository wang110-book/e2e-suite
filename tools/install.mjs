#!/usr/bin/env node
// install.mjs — 本仓库 → 本机 ZCode 运行时（维护者部署用；普通用户走插件市场安装）
//
// 数据去向（2026-10-18 改版：旧 dev-default-plugins 市场已删除，指向它的部署路径已不存在）：
//   1) 家族技能 → ~/.zcode/skills/<name>     ——总控动态发现依赖它们在此
//   2) 门禁 3 技能 + lib/hooks/mcp → e2e-suite 已安装插件缓存（版本门控，见下）
// 插件的正式发布路径是市场安装（zcode plugins update），install 只做维护者本机热调。
//
// 版本门控：缓存目录按发布版本号固化（cache/e2e-suite/e2e-suite/<ver>/）。
// 只有当仓库 package.json 版本与已安装版本一致时才推——把仓库的新实现混进旧版本
// 目录会造出"清单 1.2.3、内容 1.2.4"的缝合怪，下次发布更新还会整体盖掉。
// 仓库版本领先已安装 = 该发版了：先 bump/提交/推送，再客户端 plugins update。
//
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
  'test-case-design', 'test-namespace', 'tool-config-guide', 'ux-acceptance-test',
  'visual-design-review', 'visual-regression', 'whitebox-suite',
];
// 门禁自带技能（住在插件缓存里，不在 ~/.zcode/skills）
const GATE_SKILLS = ['gate-guide', 'gate-preflight', 'tdd-loop'];

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

// 已安装插件：installed_plugins.json 的 installPath 权威，版本目录动态跟随
function installedPlugin() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ZCODE, 'cli/plugins/installed_plugins.json'), 'utf8'));
    const e = (j.plugins || []).find(p => p.id === 'e2e-suite@e2e-suite');
    if (e && e.installPath && fs.existsSync(e.installPath)) return { dir: e.installPath, version: e.version };
  } catch {}
  return null;
}

let changed = 0;
for (const s of FAMILY_SKILLS) {
  const src = path.join(PKG, 'skills', s);
  if (!fs.existsSync(src)) { console.log(`SKIP  skills/${s}（仓库缺）`); continue; }
  const n = copyTree(src, path.join(SKILLS_DST, s));
  if (n) { console.log(`INSTALL  ~/.zcode/skills/${s}（${n}）`); changed += n; }
}

const repoVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const inst = installedPlugin();
if (!inst) {
  console.log('SKIP  门禁部分（本机未安装 e2e-suite 插件；市场安装：plugins marketplace add wang110-book/e2e-suite && plugins install e2e-suite@e2e-suite）');
} else if (inst.version !== repoVersion) {
  console.log(`SKIP  门禁部分（版本不一致：仓库 ${repoVersion} ≠ 已安装 ${inst.version}）`);
  console.log('      → 走正式发布：提交推送后客户端跑 zcode plugins update e2e-suite@e2e-suite');
} else {
  console.log(`（门禁部署目标：${inst.dir}）`);
  for (const sub of ['lib', 'hooks', 'mcp']) {
    const src = path.join(PKG, sub);
    if (!fs.existsSync(src)) continue;
    const n = copyTree(src, path.join(inst.dir, sub));
    if (n) { console.log(`INSTALL  ${path.relative(ZCODE, path.join(inst.dir, sub))}（${n}）`); changed += n; }
  }
  for (const s of GATE_SKILLS) {
    const src = path.join(PKG, 'skills', s);
    if (!fs.existsSync(src)) continue;
    const n = copyTree(src, path.join(inst.dir, 'skills', s));
    if (n) { console.log(`INSTALL  ${path.relative(ZCODE, path.join(inst.dir, 'skills', s))}（${n}）`); changed += n; }
  }
  // .mcp.json 受同样版本门控，且仓库为权威
  const src = path.join(PKG, '.mcp.json'), dst = path.join(inst.dir, '.mcp.json');
  if (fs.existsSync(src) && (!fs.existsSync(dst) || fs.readFileSync(src).compare(fs.readFileSync(dst)) !== 0)) {
    if (!DRY) fs.copyFileSync(src, dst);
    console.log(`INSTALL  ${path.relative(ZCODE, dst)}（1）`); changed++;
  }
}
console.log(DRY && changed ? `dry-run：${changed} 个文件将写入运行时` :
  changed ? `完成：${changed} 个文件已部署。重启 ZCode 宿主生效。` :
    '运行时与仓库一致，无需部署');
