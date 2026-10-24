/**
 * 卡片元素级放大截图 —— 复核纹理落位用。
 *
 * 整页截图上看不清单张卡里的淡纹，这个工具直接截某个卡片元素，
 * 按倍率放大，再可选只截卡内一块矩形（归一化坐标）。
 *
 * 用法：
 *   node elem-shot.mjs <路由> <选择器> [x0,y0,x1,y1] [--mock] [zoom=3]
 *   node elem-shot.mjs today/today .quick 0.8,0.0,1.0,0.7
 *   node elem-shot.mjs sessions/sessions .srow --mock
 *
 * 输出：/tmp/ui-shots/el-<页面>-<选择器名>.png
 */
import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'
import { installMockSocket, seedPaired, mockPayload } from './ui-harness.mjs'

const BASE = process.env.H5_BASE ?? 'http://localhost:5188'
const OUT = '/tmp/ui-shots'
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const mock = process.argv.includes('--mock')
const zoomArg = argv.find((a) => a.startsWith('zoom='))
const zoom = zoomArg ? Number(zoomArg.slice(5)) : 3
const route = argv[0]
const sel = argv[1]
const rectArg = argv.find((a) => /^\d/.test(a) && a.includes(','))
const rect = rectArg ? rectArg.split(',').map(Number) : null

await mkdir(OUT, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--allow-insecure-localhost'],
})
const page = await browser.newPage()
// 关掉缓存：改了纹理/图标后重截，浏览器还拿着旧文件，截图会和产物对不上
await page.setCacheEnabled(false)
const W = Number(process.env.VW ?? 390)
const H = Number(process.env.VH ?? 844)
await page.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: W < 700, hasTouch: W < 700 })
if (mock) {
  await page.evaluateOnNewDocument(installMockSocket)
  await page.evaluateOnNewDocument((m) => { window.__MOCK__ = m }, mockPayload({ needsAuth: !!process.env.MOCK_NEEDS_AUTH, empty: !!process.env.MOCK_EMPTY }))
}
// 本地域模式：切到「仅本机」伪域，让 mine 页的 .local-card 渲染出来
if (process.env.SEED_LOCAL) {
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('moss.work.device', 'dev-local') } catch {}
  })
}
await page.evaluateOnNewDocument(seedPaired, { skin: process.env.SKIN ?? 'moss', light: process.env.LIGHT === '1', empty: !!process.env.MOCK_EMPTY })
await page.goto(`${BASE}/#/pages/${route}`, { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, Number(process.env.WAIT_MS ?? (mock ? 3200 : 2600))))

// 需要先点开的元素（如弹层）
const clickSel = process.env.CLICK
if (clickSel) {
  const target = await page.$(clickSel)
  if (target) { await target.click(); await new Promise((r) => setTimeout(r, 700)) }
}

const el = await page.$(sel)
if (!el) { console.error(`找不到 ${sel}`); await browser.close(); process.exit(1) }
// 先滚进视口再量坐标——不然 boundingBox 给出视口外坐标，clip 出来是黑的
await el.evaluate((n) => n.scrollIntoView({ block: 'center', behavior: 'instant' }))
await new Promise((r) => setTimeout(r, 400))
const box = await el.boundingBox()
if (!box) { console.error(`${sel} 不可见`); await browser.close(); process.exit(1) }

let clip = { x: box.x, y: box.y, width: box.width, height: box.height }
if (rect) {
  clip = {
    x: box.x + rect[0] * box.width,
    y: box.y + rect[1] * box.height,
    width: (rect[2] - rect[0]) * box.width,
    height: (rect[3] - rect[1]) * box.height,
  }
}
const name = `${route.replace(/\//g, '-')}-${sel.replace(/[^a-z0-9]/gi, '')}${rect ? '-r' : ''}`
await page.screenshot({ path: `${OUT}/el-${name}.png`, clip })
console.log(`✓ el-${name}.png  ${Math.round(clip.width)}×${Math.round(clip.height)} CSS → 放大 ${zoom}×`)

// 再导一份放大版
const { execSync } = await import('node:child_process')
execSync(`/Users/ysmac/.workbuddy/binaries/python/envs/default/bin/python3 -c "
from PIL import Image
im=Image.open('${OUT}/el-${name}.png')
im.resize((im.width*${zoom},im.height*${zoom}),Image.LANCZOS).save('${OUT}/el-${name}-z${zoom}.png')
"`)
await browser.close()
