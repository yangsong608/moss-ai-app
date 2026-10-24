/**
 * 原型三档画幅程序化验收（一条命令复验）：
 *   node verify.mjs
 *
 * 路径：Chrome headless 加载 harness.html（三个固定画幅 iframe 内跑断言）
 *      → --dump-dom 读回 <pre id="results">。
 * 不用 puppeteer：本机 Chrome(155) × puppeteer-core(25) 的 CDP 会话不稳
 * （setViewport 杀 Emulation 会话、newPage/goto 竞态、launch 超时），
 * 而 Chrome CLI 加上 --no-sandbox/--disable-gpu 后稳定可靠。
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const html = execFileSync(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--use-gl=disabled', '--disable-breakpad', '--no-first-run',
  '--user-data-dir=/tmp/chrome-moss-profile', '--allow-file-access-from-files',
  '--virtual-time-budget=10000', '--dump-dom',
  `file://${resolve(HERE, 'harness.html')}`,
], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })

const m = html.match(/<pre id="results">([\s\S]*?)<\/pre>/)
if (m === null) {
  console.error('未取到 harness 结果（<pre id="results"> 缺失）')
  process.exit(1)
}
const text = m[1]
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
console.log(text)
process.exit(text.includes('ALL_PASS') ? 0 : 1)
