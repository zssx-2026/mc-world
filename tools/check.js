#!/usr/bin/env node
'use strict';
/* ============================================================
 * MC-World 网页端静态自检（零依赖，仅用 node: 内置模块）
 * 用法：node tools/check.js
 * 行为：起本地静态服务器 -> 抓每个页面 -> 解析 src/href ->
 *       逐个请求本地资源 -> 校验 JS 语法/编码/HTML 基本结构 ->
 *       结果打印并落盘 tools/check-result.txt
 * ============================================================ */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PAGES = ['index.html', 'play.html', 'servers.html', 'connect.html', 'account.html', 'rules.html', 'shop.html', '404.html'];
const REQUIRED = PAGES.concat([
  'config.js', 'favicon.svg', 'robots.txt', 'README.md',
  'assets/css/style.css',
  'assets/js/util.js', 'assets/js/mock.js', 'assets/js/api.js', 'assets/js/nav.js',
  'assets/js/home.js', 'assets/js/servers.js', 'assets/js/account.js',
  'assets/js/shop.js', 'assets/js/connect.js',
  'tools/check.js', 'tools/serve.js'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const out = [];
const failures = [];
let pass = 0;

function ok(msg) { pass += 1; out.push('[PASS] ' + msg); }
function bad(msg) { failures.push(msg); out.push('[FAIL] ' + msg); }
function note(msg) { out.push('[INFO] ' + msg); }
function section(title) { out.push(''); out.push('## ' + title); }

function walk(dir, acc) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    if (d.name === '.git' || d.name === 'node_modules') return;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walk(full, acc);
    else acc.push(full);
  });
  return acc;
}

function createServer() {
  const server = http.createServer(function (req, res) {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    fs.readFile(file, function (err, buf) {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found: ' + urlPath);
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, port: server.address().port });
    });
  });
}

function get(port, urlPath) {
  return new Promise(function (resolve) {
    const req = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: 'GET', timeout: 8000 }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) { resolve({ status: 0, type: '', body: Buffer.alloc(0), error: e.message }); });
    req.end();
  });
}

function decodeUtf8(buf) {
  const td = new TextDecoder('utf-8', { fatal: true });
  return td.decode(buf);
}

function refsOf(html) {
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  const list = [];
  let m;
  while ((m = re.exec(html)) !== null) list.push(m[1].trim());
  return list;
}

function classify(page, ref) {
  if (!ref) return null;
  if (/^(#|mailto:|tel:|javascript:|data:|blob:)/i.test(ref)) return null;
  if (/^https?:\/\//i.test(ref) || /^\/\//.test(ref)) return { kind: 'external', url: ref };
  if (ref.startsWith('/')) return { kind: 'absolute', url: ref };
  const clean = ref.split('#')[0].split('?')[0];
  if (!clean) return null;
  const base = path.posix.dirname('/' + page);
  const resolved = path.posix.normalize(path.posix.join(base, clean));
  return { kind: 'local', url: resolved, raw: ref };
}

async function main() {
  const started = Date.now();
  out.push('MC-World 网页端静态检查');
  out.push('时间: ' + new Date().toISOString());
  out.push('根目录: ' + ROOT);

  section('1. 必需文件');
  let missing = 0;
  REQUIRED.forEach(function (rel) {
    if (fs.existsSync(path.join(ROOT, rel))) ok('存在 ' + rel);
    else { missing += 1; bad('缺失 ' + rel); }
  });
  if (missing === 0) out.push('  -> ' + REQUIRED.length + ' 个必需文件齐全');

  section('2. 本地静态服务器 + 页面 200');
  const srv = await createServer();
  out.push('  监听 127.0.0.1:' + srv.port + '（随机端口）');

  const pageBodies = {};
  for (const page of PAGES) {
    const res = await get(srv.port, '/' + page);
    const body = res.body.toString('utf8');
    if (res.status === 200) ok('GET /' + page + ' -> 200 (' + res.body.length + ' bytes)');
    else bad('GET /' + page + ' -> ' + res.status + (res.error ? ' ' + res.error : ''));
    if (!/text\/html/.test(res.type)) bad(page + ' Content-Type 不是 text/html: ' + res.type);
    if (!/^<!DOCTYPE html>/i.test(body.trim())) bad(page + ' 缺少 <!DOCTYPE html>');
    if (!/<html lang="zh-CN">/.test(body)) bad(page + ' 缺少 lang="zh-CN"');
    if (!/<meta charset="utf-8">/i.test(body)) bad(page + ' 缺少 <meta charset="utf-8">');
    if (!/<meta name="viewport"/i.test(body)) bad(page + ' 缺少 viewport meta');
    if (!/<title>[^<]{2,}<\/title>/.test(body)) bad(page + ' 缺少有效 <title>');
    if (!/<link rel="stylesheet" href="\.\/assets\/css\/style\.css">/.test(body)) bad(page + ' 未引用 ./assets/css/style.css');
    if (!/<script src="\.\/config\.js" defer><\/script>/.test(body)) bad(page + ' 未以 defer 引入 ./config.js');
    pageBodies[page] = body;
  }

  section('3. 资源引用 404 检测');
  const seen = new Map();
  let localCount = 0;
  for (const page of PAGES) {
    for (const ref of refsOf(pageBodies[page])) {
      const c = classify(page, ref);
      if (!c) continue;
      if (c.kind === 'external') { bad(page + ' 引用外部资源（应零外部依赖）: ' + c.url); continue; }
      if (c.kind === 'absolute') { bad(page + ' 使用根绝对路径（GitHub Pages 子路径会 404）: ' + c.url); continue; }
      localCount += 1;
      if (seen.has(c.url)) continue;
      const res = await get(srv.port, c.url);
      const filePath = path.join(ROOT, c.url);
      const exists = fs.existsSync(filePath);
      if (res.status === 200 && exists) {
        seen.set(c.url, true);
      } else {
        seen.set(c.url, false);
        bad(page + ' 引用资源不存在: ' + c.raw + ' -> ' + c.url + ' (HTTP ' + res.status + ')');
      }
    }
  }
  const uniqueLocal = seen.size;
  const goodLocal = Array.from(seen.values()).filter(Boolean).length;
  if (goodLocal === uniqueLocal) ok('本地资源引用全部可访问（' + localCount + ' 处引用 / ' + uniqueLocal + ' 个唯一资源）');
  else bad('存在不可访问资源：' + (uniqueLocal - goodLocal) + ' 个');

  section('4. JS 语法（vm.Script 编译，不执行）');
  const jsFiles = walk(path.join(ROOT, 'assets', 'js'), []).concat([
    path.join(ROOT, 'config.js'),
    path.join(ROOT, 'tools', 'check.js'),
    path.join(ROOT, 'tools', 'serve.js')
  ]);
  let jsBad = 0;
  jsFiles.forEach(function (file) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    try {
      const src = fs.readFileSync(file, 'utf8');
      new vm.Script(src, { filename: rel });
      ok('语法通过 ' + rel);
    } catch (e) {
      jsBad += 1;
      bad('语法错误 ' + rel + ': ' + e.message);
    }
  });
  if (jsBad === 0) out.push('  -> ' + jsFiles.length + ' 个 JS 文件全部通过语法编译');

  section('5. 编码与 BOM');
  const textFiles = walk(ROOT, []).filter(function (f) {
    return /\.(html|css|js|svg|txt|md|json)$/i.test(f);
  });
  let bomBad = 0;
  let utf8Bad = 0;
  textFiles.forEach(function (file) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const buf = fs.readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      bomBad += 1;
      bad('含 UTF-8 BOM: ' + rel);
    }
    try {
      decodeUtf8(buf);
    } catch (e) {
      utf8Bad += 1;
      bad('不是合法 UTF-8: ' + rel);
    }
  });
  if (bomBad === 0) ok('全部 ' + textFiles.length + ' 个文本文件无 BOM');
  if (utf8Bad === 0) ok('全部文本文件为合法 UTF-8');

  section('6. 交互与安全约定');
  const jsAll = jsFiles.map(function (f) { return { rel: path.relative(ROOT, f).replace(/\\/g, '/'), src: fs.readFileSync(f, 'utf8') }; });
  const popup = jsAll.filter(function (f) { return /(^|[^.\w])(alert|confirm|prompt)\s*\(/.test(f.src); });
  if (popup.length) popup.forEach(function (f) { bad('使用阻塞式弹窗（违反不弹窗约束）: ' + f.rel); });
  else ok('JS 未使用 alert / confirm / prompt');

  const htmlAll = PAGES.map(function (p) { return { rel: p, src: pageBodies[p] }; });
  const inline = htmlAll.filter(function (p) { return /\son(click|submit|load|error)\s*=/i.test(p.src); });
  if (inline.length) inline.forEach(function (p) { bad('存在内联事件处理器: ' + p.rel); });
  else ok('HTML 无内联事件处理器');

  const absoluteAssets = htmlAll.filter(function (p) { return /(?:src|href)\s*=\s*["']\//.test(p.src); });
  if (absoluteAssets.length) absoluteAssets.forEach(function (p) { bad('存在以 / 开头的绝对资源路径: ' + p.rel); });
  else ok('全部页面使用相对路径（适配 Pages 子路径）');

  const externalCount = PAGES.reduce(function (n, p) {
    return n + refsOf(pageBodies[p]).filter(function (r) { return /^https?:/i.test(r); }).length;
  }, 0);
  if (externalCount === 0) ok('页面零外部网络依赖（离线可打开）');
  else bad('页面存在 ' + externalCount + ' 处外部引用');

  const hasLocalStorage = jsAll.some(function (f) { return /localStorage/.test(f.src); });
  if (hasLocalStorage) ok('token 存储使用 localStorage（前端零密钥）');

  section('7. 数据接口契约');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'api.js'), 'utf8');
  ['/api/status', '/api/servers', '/api/auth/register', '/api/auth/login', '/api/redirect'].forEach(function (p) {
    if (apiSrc.indexOf(p) !== -1) ok('前端实现 ' + p);
    else bad('前端缺少 ' + p);
  });
  const mockSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'mock.js'), 'utf8');
  if (/MCW\.mock\s*=/.test(mockSrc)) ok('内置 mock 数据可用于离线降级');
  else bad('缺少内置 mock 数据');

  const duration = Date.now() - started;
  out.push('');
  out.push('========================================');
  out.push('通过: ' + pass + ' 项，失败: ' + failures.length + ' 项，耗时 ' + duration + ' ms');
  out.push('结论: ' + (failures.length === 0 ? 'PASS' : 'FAIL'));
  if (failures.length) {
    out.push('');
    out.push('失败明细:');
    failures.forEach(function (f, i) { out.push('  ' + (i + 1) + '. ' + f); });
  }
  out.push('========================================');

  const text = out.join('\n') + '\n';
  fs.writeFileSync(path.join(__dirname, 'check-result.txt'), text, 'utf8');
  process.stdout.write(text);

  srv.server.close();
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch(function (e) {
  process.stderr.write('检查脚本异常: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exitCode = 2;
});
