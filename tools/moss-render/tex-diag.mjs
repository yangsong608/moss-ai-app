/**
 * 诊断某张卡的纹理 <image> 实况：元素是否存在、src 是否加载成功、
 * 计算样式、实际盒模型。用于"图案不见了"类问题。
 *
 * 用法：node tex-diag.mjs <路由> <卡选择器> [--mock] [--local]
 */
import puppeteer from 'puppeteer-core'
import { installMockSocket, seedPaired, mockPayload } from './ui-harness.mjs'

const BASE = process.env.H5_BASE ?? 'http://localhost:5188'
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const mock = process.argv.includes('--mock')
const route = argv[0]
const sel = argv[1]

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--allow-insecure-localhost'],
})
const page = await browser.newPage()
await page.setViewport({ width: Number(process.env.VW ?? 390), height: Number(process.env.VH ?? 844), deviceScaleFactor: 2 })
if (mock) {
  await page.evaluateOnNewDocument(installMockSocket)
  await page.evaluateOnNewDocument((m) => { window.__MOCK__ = m }, mockPayload({}))
}
if (process.env.SEED_LOCAL) {
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('moss.work.device', 'dev-local') } catch {} })
}
await page.evaluateOnNewDocument(seedPaired, { skin: 'moss', light: false })
await page.goto(`${BASE}/#/pages/${route}`, { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 3000))
if (process.env.CLICK) {
  const t = await page.$(process.env.CLICK)
  if (t) { await t.click(); await new Promise((r) => setTimeout(r, 800)) }
}

const info = await page.evaluate((sel) => {
  const card = document.querySelector(sel)
  if (!card) return { error: `找不到卡 ${sel}` }
  const tex = card.querySelector('.tex') || card.querySelector('image')
  const cr = card.getBoundingClientRect()
  const out = {
    card: { w: Math.round(cr.width), h: Math.round(cr.height) },
    tex: null,
  }
  if (!tex) { out.tex = '卡内没有 .tex / image 元素'; return out }
  const tr = tex.getBoundingClientRect()
  const cs = getComputedStyle(tex)
  out.tex = {
    tag: tex.tagName,
    src: tex.getAttribute('src') || tex.src,
    loaded: tex.tagName === 'IMAGE' ? [tex.naturalWidth, tex.naturalHeight] : null,
    box: { w: Math.round(tr.width), h: Math.round(tr.height), x: Math.round(tr.left - cr.left), y: Math.round(tr.top - cr.top) },
    computed: {
      position: cs.position, zIndex: cs.zIndex, opacity: cs.opacity,
      display: cs.display, visibility: cs.visibility,
      mixBlend: cs.mixBlendMode, filter: cs.filter,
      transform: cs.transform,
    },
    parentBg: getComputedStyle(tex.parentElement).backgroundColor,
  }
  return out
}, sel)

console.log(JSON.stringify(info, null, 2))
await browser.close()
