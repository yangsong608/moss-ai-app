/**
 * 高保真原型三档画幅截图：
 *   node shot.mjs   → ./shots/{phone,tablet-portrait,tablet-landscape}.png
 *
 * 画幅约定（与 index.html 断点一致）：
 *   phone            390×844   <820px  底部 5 Tab
 *   tablet-portrait  820×1180  820–1099px 左侧栏 + 单列
 *   tablet-landscape 1280×800  ≥1100px 左侧栏 + 主区 + 右栏
 *
 * 用 Chrome CLI 出图（不用 puppeteer，原因见 verify.mjs 头注）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORTS = [
  ['phone', 390, 844],
  ['tablet-portrait', 820, 1180],
  ['tablet-landscape', 1280, 800],
]
// 关键视图（hash 直达，便于逐屏评审）
const VIEWS = [
  ['today', ''],
  ['board', '#today-board'],
  ['calendar', '#calendar'],
  ['notes', '#notes'],
  ['focus', '#focus'],
  ['news', '#news'],
  ['detail', '#today-detail'],
]

mkdirSync(resolve(HERE, 'shots'), { recursive: true })
for (const [name, w, h] of VIEWPORTS) {
  for (const [view, hash] of (name === 'phone' ? VIEWS : [['today', ''], ['detail', '#today-detail'], ['calendar', '#calendar']])) {
  execFileSync(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
    '--use-gl=disabled', '--disable-breakpad', '--no-first-run', '--hide-scrollbars',
    '--user-data-dir=/tmp/chrome-moss-profile',
    `--screenshot=${resolve(HERE, 'shots', `${name}-${view}.png`)}`,
    `--window-size=${w},${h}`,
    `file://${resolve(HERE, 'index.html')}${hash}`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  console.log(`${name}-${view} ${w}×${h} → shots/${name}-${view}.png`)
  }
}
