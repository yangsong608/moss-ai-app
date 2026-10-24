/**
 * 我自己的轻量验收（不替代 verify.mjs，只是在 puppeteer 竞态下兜底）：
 *   node _check.mjs
 * 覆盖：三档画幅布局断言 + 无 JS 报错 + 五 Tab 切换 + 主要交互可达。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire('/Volumes/软件目录/work/zkxh/deepseek/dsh-link-suite/docs/prototype/package.json')
const puppeteer = require('puppeteer-core')

const HERE = dirname(fileURLToPath(import.meta.url))
const URL = `file://${resolve(HERE, 'index.html')}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TABS = [
  ['今天', ['收件箱']],
  ['日历', ['周', '安排']],
  ['专注', ['专注', '25']],
  ['资讯', ['检索', '订阅']],
  ['我的', ['笔记', '设置']],
]
const CASES = [
  ['phone', 390, 844, 'bottom'],
  ['tablet-portrait', 820, 1180, 'left'],
  ['tablet-landscape', 1280, 800, 'left+right'],
]
let failed = 0
const ok = (cond, label) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`)
  if (!cond) failed += 1
}

for (const [name, width, height, layout] of CASES) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, defaultViewport: null,
    args: [`--window-size=${width},${height}`, '--hide-scrollbars', '--no-sandbox'],
    timeout: 60000,
  })
  const page = await browser.newPage()
  await new Promise((r) => setTimeout(r, 400))
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  for (let i = 0; ; i += 1) {
    try { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 }); break }
    catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 400)) }
  }
  await new Promise((r) => setTimeout(r, 300))
  console.log(`\n■ ${name} ${width}×${height}（期望导航：${layout}）`)
  ok(errors.length === 0, `无 JS 报错${errors.length ? '（' + errors[0] + '）' : ''}`)

  for (const [tab, expect] of TABS) {
    const found = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('a,button,div,span,li')].filter(
        (e) => e.textContent.trim() === t && e.offsetParent !== null && e.getBoundingClientRect().width > 0)
      if (!els.length) return false
      const boxes = els.map((e) => ({ el: e, r: e.getBoundingClientRect() }))
      boxes.sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)
      boxes[0].el.click()
      return true
    }, tab)
    ok(found, `Tab「${tab}」存在并可点`)
    await new Promise((r) => setTimeout(r, 150))
    const bodyText = await page.evaluate(() => document.body.innerText)
    ok(expect.every((kw) => bodyText.includes(kw)), `「${tab}」渲染（含 ${expect.join('/')}）`)
  }

  const navBox = await page.evaluate(() => {
    const els = [...document.querySelectorAll('a,button,div,span,li')].filter(
      (e) => e.textContent.trim() === '今天' && e.offsetParent !== null)
    if (!els.length) return null
    const boxes = els.map((e) => e.getBoundingClientRect().toJSON())
    boxes.sort((a, b) => a.width * a.height - b.width * b.height)
    return boxes[0]
  })
  if (navBox) {
    if (layout === 'bottom') ok(navBox.y > height * 0.75, `导航在底部（y=${Math.round(navBox.y)}）`)
    else ok(navBox.x < 160, `导航在左侧栏（x=${Math.round(navBox.x)}）`)
    if (layout === 'left+right') {
      const rightHit = await page.evaluate(() => {
        const hits = [...document.querySelectorAll('*')].filter((e) =>
          e.children.length === 0 && /详情|队列|安排|冲突副本/.test(e.textContent ?? ''))
        return hits.some((e) => e.getBoundingClientRect().x > window.innerWidth * 0.58)
      })
      ok(rightHit, '横屏右栏内容在右侧 58% 以外')
    }
  } else ok(false, '未找到导航 Tab「今天」')

  // 交互冒烟（只在 phone 档跑一遍，覆盖点击路径）
  if (name === 'phone') {
    const steps = [
      ['勾选任务行', () => { document.querySelector('.trow .check').click(); return !!document.querySelector('.trow .check') }],
      ['切看板', () => { document.querySelector('[data-view="board"]').click(); return !document.querySelector('#taskBoard').hidden }],
      ['切回清单', () => { document.querySelector('[data-view="list"]').click(); return !document.querySelector('#taskList').hidden }],
      ['打开任务详情抽屉', () => { document.querySelector('.trow').click(); return document.querySelector('#drawer').classList.contains('on') }],
      ['关闭抽屉', () => { document.querySelector('#drawerClose').click(); return !document.querySelector('#drawer').classList.contains('on') }],
      ['快速记录回车建任务', () => {
        const inp = document.querySelector('#quickTask'); inp.value = '测试：回车连建'
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        inp.value = '测试：第二条'; inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return [...document.querySelectorAll('.trow .tt')].some((e) => e.textContent.includes('测试：第二条'))
      }],
    ]
    for (const [label, fn] of steps) {
      const r = await page.evaluate(fn)
      ok(r, '交互 · ' + label)
      await new Promise((res) => setTimeout(res, 80))
    }
    const more = await page.evaluate(() => {
      const out = {}
      document.querySelector('#btnSync').click()
      out.syncPop = document.querySelector('#popSync').classList.contains('on')
      document.querySelector('#btnSyncNow').click()
      document.querySelector('[data-go="calendar"]').click()
      document.querySelector('[data-cal="month"]').click()
      out.month = !document.querySelector('#monthView').hidden
      document.querySelector('[data-cal="week"]').click()
      document.querySelector('#wkNext').click()
      document.querySelector('#wkToday').click()
      document.querySelector('[data-go="focus"]').click()
      document.querySelector('#btnTimer').click()
      document.querySelector('[data-min="45"]').click()
      document.querySelector('#swImm').click()
      out.imm = document.body.classList.contains('immersive')
      document.querySelector('#immExit').click()
      document.querySelector('[data-go="news"]').click()
      document.querySelector('[data-nf="前端"]').click()
      out.newsFiltered = document.querySelectorAll('.ncard').length > 0
      document.querySelector('#btnFetch').click()
      document.querySelector('[data-go="me"]').click()
      document.querySelector('[data-note="n2"]').click()
      document.querySelector('[data-act="ai-polish"]').click()
      out.modal = document.querySelector('#modal').classList.contains('on')
      document.querySelector('[data-act="modal-close"]').click()
      document.querySelector('[data-me="settings"]').click()
      document.querySelector('[data-skin-pick="550w"]').click()
      out.skin550w = document.body.dataset.skin === '550w'
      document.querySelector('[data-light-pick="1"]').click()
      out.light = document.body.dataset.light === '1'
      document.querySelector('#btnCapture').click()
      const cap = document.querySelector('#capInput'); cap.value = '捕捉测试'
      document.querySelector('#capSave').click()
      out.captured = document.querySelector('#toasts').children.length > 0
      document.querySelector('#btnChat').click()
      const ci = document.querySelector('#chatInput'); ci.value = '你好 MOSS'
      ci.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('#btnSend').click()
      out.chatMsg = document.querySelectorAll('#chatFlow .ubub').length >= 2
      return out
    })
    ok(more.syncPop, '交互 · 同步面板弹出')
    ok(more.month, '交互 · 日历月视图')
    ok(more.imm, '交互 · 沉浸模式')
    ok(more.newsFiltered, '交互 · 资讯订阅筛选')
    ok(more.modal, '交互 · AI 完善 modal')
    ok(more.skin550w && more.light, '交互 · 皮肤/明暗切换写 data 属性')
    ok(more.captured, '交互 · 快速捕捉 toast')
    ok(more.chatMsg, '交互 · 对话发送')
    const err2 = errors.length
    ok(err2 === 0, `交互全程无 JS 报错${errors.length ? '（' + errors[0] + '）' : ''}`)
  }
  await browser.close()
}
console.log(failed === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failed} 项断言失败`)
process.exit(failed === 0 ? 0 : 1)
