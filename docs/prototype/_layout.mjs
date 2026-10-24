/**
 * 布局审计（代替目测）：横向溢出 / 元素越界 / 顶栏重叠 / 关键元素可见。
 *   node _layout.mjs
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire('/Volumes/软件目录/work/zkxh/deepseek/dsh-link-suite/docs/prototype/package.json')
const puppeteer = require('puppeteer-core')

const HERE = dirname(fileURLToPath(import.meta.url))
const URL = `file://${resolve(HERE, 'index.html')}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SIZES = [[360, 780], [390, 844], [820, 1180], [1024, 800], [1280, 800], [1440, 900]]
let failed = 0
const ok = (c, l) => { console.log(`${c ? '  ✓' : '  ✗'} ${l}`); if (!c) failed += 1 }

for (const [width, height] of SIZES) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, defaultViewport: null,
    args: [`--window-size=${width},${height}`, '--hide-scrollbars', '--no-sandbox'], timeout: 60000,
  })
  const page = await browser.newPage()
  await new Promise((r) => setTimeout(r, 400))
  for (let i = 0; ; i += 1) {
    try { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 }); break }
    catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 400)) }
  }
  await new Promise((r) => setTimeout(r, 350))
  console.log(`\n■ ${width}×${height}`)

  // 逐屏检查：不横向滚动、元素不越界
  for (const tab of ['today', 'calendar', 'focus', 'news', 'me', 'chat', 'devices']) {
    const r = await page.evaluate((t) => {
      document.querySelectorAll('[data-go]').forEach((b) => { if (b.dataset.go === t) b.click() })
      const inner = window.innerWidth
      const over = []
      const scrollable = (el) => {
        for (let p = el; p && p !== document.body; p = p.parentElement) {
          const s = getComputedStyle(p)
          if (s.overflowX === 'auto' || s.overflowX === 'scroll') return true
        }
        return false
      }
      document.querySelectorAll('*').forEach((el) => {
        const s = getComputedStyle(el)
        if (s.display === 'none' || s.visibility === 'hidden' || !el.offsetParent && s.position !== 'fixed') return
        if (el.closest('.pop:not(.on), .drawer:not(.on), .modal:not(.on)')) return // 未唤起的浮层不计越界
        const b = el.getBoundingClientRect()
        if (b.width === 0 || b.height === 0) return
        if ((b.right > inner + 1.5 || b.left < -1.5) && !scrollable(el)) {
          over.push(el.tagName + '.' + (el.className || '').toString().split(' ')[0] + ' [' + Math.round(b.left) + ',' + Math.round(b.right) + ']')
        }
      })
      return { over: over.slice(0, 6), pageScrollX: document.documentElement.scrollWidth - inner }
    }, tab)
    ok(r.pageScrollX <= 1, `#${tab} 无页面级横向滚动${r.pageScrollX > 1 ? '（超出 ' + r.pageScrollX + 'px）' : ''}`)
    ok(r.over.length === 0, `#${tab} 无元素越界${r.over.length ? ' → ' + r.over.join(' | ') : ''}`)
  }

  // 顶栏直接子元素不互相重叠
  const tb = await page.evaluate(() => {
    const kids = [...document.querySelector('.topbar').children].filter((e) => getComputedStyle(e).display !== 'none')
    const boxes = kids.map((e) => ({ n: e.id || e.className, r: e.getBoundingClientRect() }))
    const hits = []
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r
      const ov = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      if (ov > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) hits.push(boxes[i].n + ' × ' + boxes[j].n)
    }
    return hits
  })
  ok(tb.length === 0, `顶栏无元素重叠${tb.length ? ' → ' + tb.join(' | ') : ''}`)

  // 关键元素可见：五 Tab/侧栏、画幅提示、同步徽标、快速记录输入框（回到首页再查）
  const key = await page.evaluate(() => {
    document.querySelectorAll('[data-go="today"]').forEach((b) => b.click())
    const vis = (sel) => { const e = document.querySelector(sel); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 }
    return {
      tabs: [...document.querySelectorAll('.tab,.rtab')].filter((e) => e.getBoundingClientRect().width > 0).length,
      hint: vis('.bp-hint'), sync: vis('#btnSync'), quick: vis('#quickTask'), devsw: vis('#btnDev'),
    }
  })
  ok(key.tabs >= 5, `导航项可见 ${key.tabs} 个（≥5）`)
  ok(key.hint && key.sync && key.quick && key.devsw, '画幅提示/同步徽标/快速记录/设备切换器均可见')
  await browser.close()
}
console.log(failed === 0 ? '\n✅ 布局审计全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
