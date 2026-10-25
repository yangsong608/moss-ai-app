/**
 * 页面 smoke：构建产物逐路由渲染检查（P0-5）
 *
 * 做法：起一个静态服务托管 dist/build/h5 → 用 Chrome headless 打开每个 hash 路由
 *      → --dump-dom 取 DOM → 去标签取可见文本 → 断言关键文案。
 *
 * 为什么不用 puppeteer：本机 Chrome(155) × puppeteer-core(25) 的 CDP 会话不稳
 * （setViewport 杀 Emulation、goto 竞态），Chrome CLI 稳定且零依赖。
 *
 * 用法：npm run smoke（需先 npm run build:h5）
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 默认验 uni CLI 的 H5 产物；HBuilderX 发行产物用 --dir dist/build/web
const dirArg = process.argv.indexOf('--dir')
const DIST = dirArg > -1 && typeof process.argv[dirArg + 1] === 'string'
  ? resolve(ROOT, process.argv[dirArg + 1])
  : join(ROOT, 'dist/build/h5')
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** 每条路由配一组必须出现的文案（越多越能抓住"白屏/渲染失败"） */
const ROUTES = [
  ['pages/index/index', ['设备', '配对'], '入口：设备与配对'],
  ['pages/today/today', ['今天', '记一件事', '今天'], '今天'],
  ['pages/calendar/calendar', ['日历', '周一', '今天'], '日历周视图'],
  ['pages/notes/notes', ['笔记', '新建', '全部'], '笔记列表'],
  ['pages/note-edit/note-edit?id=n1&preview=1', ['同步引擎', '分域单主', '编辑'], '笔记整页编辑器'],
  ['pages/focus/focus', ['专注', '25:00', '开始专注'], '专注计时'],
  ['pages/news/news', ['资讯', '立即检索', '摘要'], '资讯流'],
  ['pages/sessions/sessions', ['会话'], '会话列表'],
  ['pages/chat/chat', ['没有指定会话', '重连'], '对话页'],
  ['pages/mine/mine', ['我的', '任务', '同步'], '我的'],
  ['pages/me/me', ['MOSS', '关于'], '关于'],
]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

/**
 * 静态服务必须跑在**独立进程**里：
 * 本脚本用 execFileSync 调 Chrome（同步），若服务在同进程，事件循环被阻塞，
 * Chrome 永远等不到响应 → ETIMEDOUT（第一版就是这么卡住的）。
 */
async function freePort() {
  const srv = createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  return port
}

async function startServer() {
  const port = await freePort()
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', DIST], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  // 轮询就绪：python 在部分版本上不打端口日志，不能靠解析日志
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/index.html`)
      if (res.ok) return { child, port }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  child.kill('SIGKILL')
  throw new Error('静态服务启动超时')
}

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

let failed = 0
const { child: server, port } = await startServer()
console.log(`smoke · ${ROUTES.length} 个路由 · 端口 ${port} · 产物 ${DIST}`)

for (const [route, keywords, label] of ROUTES) {
  const url = `http://127.0.0.1:${port}/#/${route}`
  let html = ''
  const dump = () => execFileSync(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
      '--use-gl=disabled', '--disable-breakpad', '--no-first-run', '--hide-scrollbars',
      // 路由里可能带 ?id=…&preview=1：目录名只留字母数字与 -，避免出现 ? & 之类的路径
      `--user-data-dir=/tmp/chrome-moss-smoke-${process.pid}-${route.replace(/[^a-zA-Z0-9-]/g, '-')}`,
      '--virtual-time-budget=5000', '--dump-dom', url,
    ], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 45_000,
      killSignal: 'SIGKILL',
    })
  try {
    html = dump()
    // 偶发白屏（Chrome 冷启动/首帧未就绪）：内容过短就重试一次
    if (visibleText(html).length < 120) {
      await new Promise((r) => setTimeout(r, 800))
      html = dump()
    }
  } catch (err) {
    console.log(`  ✗ ${label}（${route}）：Chrome 调用失败 ${String(err).slice(0, 120)}`)
    failed += 1
    continue
  }
  const text = visibleText(html)
  const missing = keywords.filter((k) => !text.includes(k))
  if (missing.length === 0) {
    console.log(`  ✓ ${label}（${text.length} 字符）`)
  } else {
    console.log(`  ✗ ${label}：缺文案 ${missing.join(' / ')}（可见 ${text.length} 字符）`)
    failed += 1
  }
}

server.kill('SIGKILL')
console.log(failed === 0 ? `\n✅ smoke 全过（${ROUTES.length}/${ROUTES.length}）` : `\n❌ ${failed} 条路由失败`)
process.exit(failed === 0 ? 0 : 1)
