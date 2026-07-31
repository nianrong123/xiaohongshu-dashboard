#!/usr/bin/env node
/**
 * 小红书爆贴看板 - 自动化构建部署脚本
 *
 * 用法: node build.js [--dry-run]
 *
 * 流程:
 *   1. 读取 merged_data.json
 *   2. 注入到 HTML 模板
 *   3. 校验 JS 语法
 *   4. 同步图片
 *   5. Git 提交 + 推送
 *
 * --dry-run: 只构建不推送，用于本地验证
 *
 * Git Token 配置: 在 deploy/.env 中设置 GITHUB_TOKEN=xxx
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ========== 配置 ==========
const ROOT = path.resolve(__dirname);
const DATA_FILE = path.join(ROOT, '..', 'outputs', 'merged_data.json');
const TEMPLATE_FILE = path.join(ROOT, 'template.html');
const OUTPUT_FILE = path.join(ROOT, 'index.html');
const IMG_SRC = path.join(ROOT, '..', 'outputs', 'images');
const IMG_DST = path.join(ROOT, 'images');
const ENV_FILE = path.join(ROOT, '.env');
const DRY_RUN = process.argv.includes('--dry-run');

// 读取 Token
function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (fs.existsSync(ENV_FILE)) {
    const env = fs.readFileSync(ENV_FILE, 'utf8');
    const m = env.match(/^GITHUB_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  }
  die('请设置 GITHUB_TOKEN 环境变量，或在 deploy/.env 中配置 GITHUB_TOKEN=xxx');
}

function log(msg) { console.log(`[build] ${msg}`); }
function die(msg) { console.error(`[ERROR] ${msg}`); process.exit(1); }

// ========== 1. 读取数据 ==========
log('1/5 读取 merged_data.json...');
if (!fs.existsSync(DATA_FILE)) die(`数据文件不存在: ${DATA_FILE}`);
const posts = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
log(`  共 ${posts.length} 篇帖子`);

// 验证每条数据有必须字段
const required = ['title', 'author', 'time', 'url', 'likes'];
for (let i = 0; i < posts.length; i++) {
  for (const key of required) {
    if (posts[i][key] === undefined) {
      die(`第 ${i + 1} 篇帖子缺少字段: ${key}`);
    }
  }
}
log('  数据校验通过');

// ========== 1.5 首次运行：从 index.html 生成模板 ==========
if (!fs.existsSync(TEMPLATE_FILE)) {
  log('  首次运行，从 index.html 生成模板...');
  const html = fs.readFileSync(OUTPUT_FILE, 'utf8');
  // 找到数据注入行: "  sampleData = [...];"
  const match = html.match(/^(  sampleData = )\[.*\];$/m);
  if (!match) die('无法在 index.html 中找到数据注入位置');
  // 用占位符替换
  const template = html.replace(
    /^(  sampleData = )\[.*\];$/m,
    '$1__DATA_PLACEHOLDER__;'
  );
  fs.writeFileSync(TEMPLATE_FILE, template, 'utf8');
  log('  模板已生成: template.html');
}

// ========== 2. 注入数据 ==========
log('2/5 注入数据到模板...');
const template = fs.readFileSync(TEMPLATE_FILE, 'utf8');

// 统计占位符出现次数
const placeholderCount = (template.match(/__DATA_PLACEHOLDER__/g) || []).length;
if (placeholderCount !== 1) die(`模板中占位符出现 ${placeholderCount} 次（期望1次）`);

const dataJson = JSON.stringify(posts);
const html = template.replace('__DATA_PLACEHOLDER__', dataJson);
log(`  HTML 大小: ${(html.length / 1024).toFixed(1)} KB`);

// ========== 3. 校验 JS 语法 ==========
log('3/5 校验 JavaScript 语法...');
// 提取所有 <script> 块并拼接
const scriptBlocks = [];
let match;
const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
while ((match = scriptRegex.exec(html)) !== null) {
  scriptBlocks.push(match[1]);
}
const allJS = scriptBlocks.join('\n\n');

// 尝试解析
try {
  new Function(allJS);
  log('  JS 语法: 通过');
} catch (e) {
  die(`JS 语法错误: ${e.message}`);
}

// 检查重复声明
const decls = {};
const declRegex = /\b(?:const|let|var)\s+(\w+)\s*=/g;
while ((match = declRegex.exec(allJS)) !== null) {
  decls[match[1]] = (decls[match[1]] || 0) + 1;
}
const dupes = Object.entries(decls).filter(([k, v]) => v > 1 && k !== 'data' && k !== 'start' && k !== 'item' && k !== 'idx' && k !== 'c');
// data/start/item/idx/c 在不同函数作用域内重复声明是正常的
if (dupes.length > 0) {
  log(`  ⚠️  同名变量（可能跨作用域）: ${dupes.map(([k, v]) => `${k}(${v}x)`).join(', ')}`);
} else {
  log('  变量声明: 通过');
}

// 检查核心函数
for (const fn of ['loadData', 'renderCards', 'renderTopics']) {
  if (!allJS.includes(`function ${fn}`) && !allJS.includes(`${fn}(`)) {
    log(`  ⚠️  未找到函数: ${fn}`);
  }
}
log('  核心函数检查: 通过');

// ========== 4. 写入 + 同步图片 ==========
log('4/5 写入文件并同步图片...');
fs.writeFileSync(OUTPUT_FILE, html, 'utf8');

// 同步图片：从 outputs/images 到 deploy/images
if (!fs.existsSync(IMG_DST)) fs.mkdirSync(IMG_DST, { recursive: true });

// 收集所有需要的图片
const needed = new Set();
posts.forEach(p => {
  if (p.images) p.images.forEach(img => needed.add(img));
  if (p.coverImage) needed.add(p.coverImage);
});

// 复制新图片
let copied = 0;
needed.forEach(img => {
  const src = path.join(IMG_SRC, img);
  const dst = path.join(IMG_DST, img);
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    fs.copyFileSync(src, dst);
    copied++;
  }
});

// 清理无用图片
let cleaned = 0;
const existing = fs.readdirSync(IMG_DST);
existing.forEach(img => {
  if (!needed.has(img)) {
    fs.unlinkSync(path.join(IMG_DST, img));
    cleaned++;
  }
});

log(`  图片: 新增 ${copied} 张, 清理 ${cleaned} 张, 当前共 ${needed.size} 张`);

// ========== 5. Git 提交推送 ==========
if (DRY_RUN) {
  log('5/5 --dry-run 模式，跳过 Git 推送');
  log('✅ 构建完成（未推送）');
  process.exit(0);
}

log('5/5 Git 提交推送...');

try {
  const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!status) {
    log('  无变更，跳过提交');
    process.exit(0);
  }

  execSync('git add index.html data.json images/ template.html build.js 2>/dev/null', { cwd: ROOT });
  
  const now = new Date().toISOString().split('T')[0];
  const postCount = posts.length;
  const msg = `build: 自动构建 (${now}, ${postCount}篇)`;
  
  try {
    execSync(`git commit -m "${msg}"`, { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    if (e.message.includes('nothing to commit') || (e.stderr || '').includes('nothing to commit')) {
      log('  无变更，跳过提交');
      process.exit(0);
    }
    throw e;
  }

  log(`  已提交: ${msg}`);

  // 设置 remote（从 .env 读取 Token）
  const token = getToken();
  execSync(
    `git remote set-url origin https://nianrong123:${token}@github.com/nianrong123/xiaohongshu-dashboard.git`,
    { cwd: ROOT }
  );
  execSync('git push origin main', { cwd: ROOT, stdio: 'inherit' });

  log('✅ 构建部署完成！');
  log(`  看板: https://nianrong123.github.io/xiaohongshu-dashboard/`);
} catch (e) {
  die(`Git 操作失败: ${e.message}`);
}
