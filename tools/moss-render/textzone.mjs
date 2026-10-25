/**
 * 实测卡片里每一段文字的归一化位置（x0,x1,y0,y1，相对卡片）。
 *
 * 用途：给 check-tex.py 提供真实的"文字区"，而不是靠 safe 猜。
 * safe 是出图时的意图，实测是页面的事实 —— 事实优先。
 *
 * 用法：node tools/moss-render/textzone.mjs
 */
import puppeteer from 'puppeteer-core'
import { installMockSocket, seedPaired, mockPayload } from './ui-harness.mjs'

const BASE = process.env.H5_BASE ?? 'http://localhost:5188'

/** 要测的卡片：[路由, 选择器] */
const TARGETS = [
  ['news/news', '.news-card'],
  ['mine/mine', '.console-card'],
  ['index/index', '.local'],
  ['mine/mine', '.sync-row'],
  ['index/index', '.empty'],
  ['mine/mine', '.ov-card'],
  ['index/index', '.dev'],
  ['today/today', '.quick'],
  ['today/today', '.flipcard'],
  ['calendar/calendar', '.calbar'],
  ['calendar/calendar', '.card'],
  ['focus/focus', '.focus-main'],
  ['focus/focus', '.pick-row'],
  ['me/me', '.brand-card'],
  ['me/me', '.panel'],
]

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
await page.evaluateOnNewDocument(installMockSocket)
await page.evaluateOnNewDocument((m) => { window.__MOCK__ = m }, mockPayload({}))
await page.evaluateOnNewDocument(seedPaired, { skin: 'moss', light: false })

for (const [route, sel] of TARGETS) {
  await page.goto(`${BASE}/#/pages/${route}`, { waitUntil: 'networkidle0' })
  await new Promise((r) => setTimeout(r, 3200))
  const info = await page.evaluate((selector) => {
    const card = document.querySelector(selector)
    if (!card) return null
    const cb = card.getBoundingClientRect()
    const out = []
    card.querySelectorAll('uni-text').forEach((t) => {
      const r = t.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      const txt = (t.textContent || '').trim().slice(0, 16)
      if (!txt) return
      out.push({
        txt,
        x0: +((r.left - cb.left) / cb.width).toFixed(3),
        x1: +((r.right - cb.left) / cb.width).toFixed(3),
        y0: +((r.top - cb.top) / cb.height).toFixed(3),
        y1: +((r.bottom - cb.top) / cb.height).toFixed(3),
      })
    })
    // 按文字矩形的并集，找横向空白带（每一行 y 上，文字没覆盖的 x 区间）
    const bands = []
    const rows = 40
    for (let i = 0; i < rows; i++) {
      const y0 = i / rows
      const y1 = (i + 1) / rows
      const hits = out.filter((t) => t.y1 > y0 && t.y0 < y1)
      if (!hits.length) { bands.push([y0, y1, 0, 1]); continue }
      // 合并 x 区间
      const xs = hits.map((t) => [t.x0, t.x1]).sort((a, b) => a[0] - b[0])
      const merged = [xs[0]]
      for (const [a, b] of xs.slice(1)) {
        const last = merged[merged.length - 1]
        if (a <= last[1] + 0.005) last[1] = Math.max(last[1], b)
        else merged.push([a, b])
      }
      const gaps = []
      let cursor = 0
      for (const [a, b] of merged) {
        if (a - cursor > 0.04) gaps.push([cursor, a])
        cursor = Math.max(cursor, b)
      }
      if (1 - cursor > 0.04) gaps.push([cursor, 1])
      for (const g of gaps) bands.push([y0, y1, g[0], g[1]])
    }
    return { card: { w: Math.round(cb.width), h: Math.round(cb.height) }, texts: out, bands }
  }, sel)
  console.log(`=== ${route} ${sel}`)
  if (!info) { console.log('  未找到'); continue }
  console.log('  卡尺寸', info.card)
  info.texts.forEach((t) => {
    console.log(`   "${t.txt}" x[${t.x0},${t.x1}] y[${t.y0},${t.y1}]`)
  })
  console.log('  横向空白带（宽 > 8%）：')
  info.bands.filter((b) => b[3] - b[2] > 0.08)
    .forEach((b) => console.log(`    y[${b[0].toFixed(3)},${b[1].toFixed(3)}] x[${b[2].toFixed(3)},${b[3].toFixed(3)}] 宽${((b[3] - b[2]) * 100).toFixed(0)}%`))
}
await browser.close()
