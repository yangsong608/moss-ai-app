/**
 * 通用卡片占位实测 —— 找出任意页面里每类卡片真正的空白矩形。
 *
 * 纹理图形必须落在空白处，所以需要知道：
 *   卡片矩形、卡片内每个文字/控件元素的矩形
 * 然后据此决定图形的锚点（anchor）。
 *
 * 用法：
 *   node tools/moss-render/slot.mjs <页面路由> <key=选择器> [key=选择器 ...] [--mock]
 *   node tools/moss-render/slot.mjs notes note=.note-card
 *   node tools/moss-render/slot.mjs sessions srow=.srow --mock
 *
 * --mock：装替身 WebSocket + 假设备/会话，让需要宿主数据的页面能渲染出卡片。
 *
 * 输出：/tmp/ui-shots/slots-<页面>.json + 控制台打印
 */

import puppeteer from 'puppeteer-core'
import { mkdir, writeFile } from 'node:fs/promises'
import { installMockSocket, seedPaired, mockPayload } from './ui-harness.mjs'

const BASE = process.env.H5_BASE ?? 'http://localhost:5188'
const OUT = '/tmp/ui-shots'

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const mock = process.argv.includes('--mock')
const route = argv[0] ?? 'today/today'
const specs = argv.slice(1).map((a) => {
  const i = a.indexOf('=')
  return { key: a.slice(0, i), sel: a.slice(i + 1) }
})
if (!specs.length) {
  console.error('用法: node slot.mjs <页面路由> <key=选择器> ...')
  process.exit(1)
}

await mkdir(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--allow-insecure-localhost'],
})

const page = await browser.newPage()
const W = Number(process.env.VW ?? 390)
const H = Number(process.env.VH ?? 844)
await page.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: W < 700, hasTouch: W < 700 })
if (mock) {
  await page.evaluateOnNewDocument(installMockSocket)
  await page.evaluateOnNewDocument((m) => { window.__MOCK__ = m }, mockPayload({ needsAuth: !!process.env.MOCK_NEEDS_AUTH, empty: !!process.env.MOCK_EMPTY }))
}
await page.evaluateOnNewDocument(seedPaired, { skin: 'moss', light: false, empty: !!process.env.MOCK_EMPTY })
await page.goto(`${BASE}/#/pages/${route}`, { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, mock ? 3200 : 2600))

const data = await page.evaluate((cards) => {
  const out = {}
  for (const c of cards) {
    const el = document.querySelector(c.sel)
    if (!el) { out[c.key] = null; continue }
    const cr = el.getBoundingClientRect()
    if (cr.width === 0) { out[c.key] = null; continue }

    const leaves = []
    el.querySelectorAll('*').forEach((n) => {
      if (n.classList?.contains?.('tex')) return
      if (n.tagName === 'IMAGE' || n.tagName === 'IMG') return
      const r = n.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      const hasText = [...n.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim())
      const noChild = n.children.length === 0
      if (!hasText && !noChild) return
      const cs = getComputedStyle(n)
      if (cs.position === 'absolute' || cs.visibility === 'hidden') return
      leaves.push({
        cls: n.className?.toString?.().slice(0, 40) || n.tagName,
        x: +((r.left - cr.left) / cr.width).toFixed(3),
        y: +((r.top - cr.top) / cr.height).toFixed(3),
        w: +(r.width / cr.width).toFixed(3),
        h: +(r.height / cr.height).toFixed(3),
        text: (n.textContent || '').trim().slice(0, 18),
      })
    })
    out[c.key] = {
      size: [Math.round(cr.width), Math.round(cr.height)],
      ratio: +(cr.width / cr.height).toFixed(3),
      leaves,
    }
  }
  return out
}, specs)

const slug = route.replace(/\//g, '-')
await writeFile(`${OUT}/slots-${slug}.json`, JSON.stringify(data, null, 2))

for (const [k, v] of Object.entries(data)) {
  if (!v) { console.log(`■ ${k}: 未找到或不可见`); continue }
  console.log(`\n■ ${k}  ${v.size[0]}×${v.size[1]} (比例 ${v.ratio})`)
  for (const l of v.leaves) {
    console.log(`   ${l.cls.padEnd(22)} x${l.x}..${(l.x + l.w).toFixed(2)}  y${l.y}..${(l.y + l.h).toFixed(2)}  "${l.text}"`)
  }
}

await browser.close()
