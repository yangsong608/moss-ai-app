/**
 * 通用整页截图 —— 4 套主题。
 *
 * 用法：node tools/moss-render/shot.mjs <路由> [输出前缀] [--mock]
 *   node tools/moss-render/shot.mjs notes/notes notes
 *   node tools/moss-render/shot.mjs sessions/sessions sessions --mock
 *
 * --mock：装上替身 WebSocket + 假设备/会话，用来截"有数据的界面"
 *         （会话页、对话页没有真实宿主就只剩空态，量不到卡片）。
 */

import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'
import { installMockSocket, seedPaired, mockPayload } from './ui-harness.mjs'

const BASE = process.env.H5_BASE ?? 'http://localhost:5188'
const OUT = '/tmp/ui-shots'
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const mock = process.argv.includes('--mock')
const route = args[0] ?? 'today/today'
const prefix = args[1] ?? route.replace(/\//g, '-')

const THEMES = [
  { skin: 'moss', light: false, label: 'moss-dark' },
  { skin: 'moss', light: true, label: 'moss-light' },
  { skin: '550w', light: false, label: '550w-dark' },
  { skin: '550w', light: true, label: '550w-light' },
]

const W = Number(process.env.VW ?? 390)
const H = Number(process.env.VH ?? 844)

await mkdir(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--allow-insecure-localhost'],
})

for (const t of THEMES) {
  const page = await browser.newPage()
  // 关掉缓存：改了纹理/图标后重截，浏览器还拿着旧文件，
  // 截出来的图和产物对不上，排查起来极浪费时间。
  await page.setCacheEnabled(false)
  await page.setViewport({
    width: W, height: H, deviceScaleFactor: 2,
    isMobile: W < 700, hasTouch: W < 700,
  })
  if (mock) {
    await page.evaluateOnNewDocument(installMockSocket)
    await page.evaluateOnNewDocument((m) => { window.__MOCK__ = m }, mockPayload({ needsAuth: !!process.env.MOCK_NEEDS_AUTH, empty: !!process.env.MOCK_EMPTY }))
  }
  await page.evaluateOnNewDocument(seedPaired, { skin: t.skin, light: t.light, empty: !!process.env.MOCK_EMPTY })

  const errs = []
  page.on('response', (r) => { if (r.status() >= 400) errs.push(`${r.status()} ${r.url()}`) })

  await page.goto(`${BASE}/#/pages/${route}`, { waitUntil: 'networkidle0' })
  // 首页有 4.3s 开机动画（MossBoot），等它播完再截，否则截到的是开机画面
  const wait = Number(process.env.WAIT_MS ?? (mock ? 3200 : 2600))
  await new Promise((r) => setTimeout(r, wait))
  await page.screenshot({ path: `${OUT}/${prefix}-${t.label}.png` })

  console.log(`✓ ${prefix}-${t.label}${errs.length ? '  ⚠ ' + errs.join('; ') : ''}`)
  await page.close()
}

await browser.close()
