import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:5188'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const errors = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

async function newPage(width, height) {
  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: width < 820, hasTouch: width < 820 })
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e)}`))
  return page
}

async function clickText(page, text, scope = 'body') {
  return page.evaluate((t, s) => {
    const root = document.querySelector(s)
    if (!root) return false
    const els = Array.from(root.querySelectorAll('uni-view,uni-text'))
    const hit = els.filter((e) => (e.textContent || '').trim() === t).pop()
    if (!hit) return false
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return true
  }, text, scope)
}

async function db(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('moss.work.dev-a')
    if (!raw) return null
    const d = JSON.parse(raw)
    return {
      n: d.tasks.length,
      first: d.tasks[0],
      review: d.tasks.find((t) => t.title.includes('评审支付')),
      doneCount: d.tasks.filter((t) => t.done).length,
    }
  })
}

try {
  /* ── 今天 ─────────────────────────────────────────────── */
  const p = await newPage(390, 844)
  await p.goto(`${BASE}/#/pages/today/today`, { waitUntil: 'networkidle0', timeout: 60000 })
  await sleep(900)

  // 快速记录：输入 + 回车（用真实节奏，避免自动化并发打字丢字）
  await p.click('.quickin .qin input')
  await p.type('.quickin .qin input', '交互测试：写一条快速记录', { delay: 70 })
  await p.keyboard.press('Enter')
  await sleep(500)
  let d = await db(p)
  log('quick add ->', d.n, 'first=', d.first.title)
  log('input keeps focus ->', await p.evaluate(() => document.activeElement?.className))

  // 勾选 / 恢复（第一条 = 刚加的）
  await p.click('.trow .check')
  await sleep(400)
  d = await db(p)
  log('toggle done ->', d.first.done, 'subs auto-done:', d.first.sub.every((s) => s.done))
  await p.click('.trow .check')
  await sleep(300)

  // 打开详情（评审任务）
  await p.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.trow')).find((r) => r.textContent.includes('评审支付模块重构方案'))
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  })
  await sleep(600)
  log('sheet open?', await p.evaluate(() => !!document.querySelector('.sheet')))
  await p.screenshot({ path: '/tmp/work/today-sheet.png' })

  await clickText(p, '等待中', '.sheet')
  await sleep(200)
  await clickText(p, '低', '.sheet')
  await sleep(200)
  await p.click('.sheet .subin input')
  await p.type('.sheet .subin input', '检查风控口径', { delay: 60 })
  await p.keyboard.press('Enter')
  await sleep(400)
  d = await db(p)
  log('detail edits ->', d.review.status, d.review.pri, 'subs=', d.review.sub.length, d.review.sub.map((s) => s.title).join('/'))
  await p.screenshot({ path: '/tmp/work/today-sheet-2.png' })

  await p.click('.sheet .x')
  await sleep(300)
  log('sheet closed?', await p.evaluate(() => !document.querySelector('.sheet')))

  // 环形进度 → 清已完成确认 → 取消
  await p.click('.ring')
  await sleep(400)
  log('confirm modal?', await p.evaluate(() => !!document.querySelector('.modal')))
  await p.screenshot({ path: '/tmp/work/today-clear.png' })
  await clickText(p, '取消')
  await sleep(200)

  // 看板
  await clickText(p, '看板')
  await sleep(500)
  log('board cols=', await p.evaluate(() => document.querySelectorAll('.bcol').length))
  await p.screenshot({ path: '/tmp/work/today-board.png' })

  // 筛选：全部 → 高优先
  await clickText(p, '筛选')
  await sleep(300)
  log('filter label=', await p.evaluate(() => document.querySelector('.fbtn')?.textContent.trim()), 'rows=', await p.evaluate(() => document.querySelectorAll('.trow').length))
  await clickText(p, '高优先')
  await sleep(200)

  // 刷新后持久化
  await p.reload({ waitUntil: 'networkidle0' })
  await sleep(700)
  d = await db(p)
  log('persisted after reload ->', d.first.title, 'review=', d.review.status, d.review.pri)

  // 清已完成：确认执行
  await p.click('.ring')
  await sleep(300)
  const clearLabel = await p.evaluate(() => document.querySelector('.modal .btn.primary')?.textContent.trim())
  log('clear button=', clearLabel)
  await p.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.modal .btn')).find((b) => b.textContent.includes('清掉'))
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  })
  await sleep(500)
  d = await db(p)
  log('after clear -> tasks=', d.n, 'done=', d.doneCount)
  await p.screenshot({ path: '/tmp/work/today-cleared.png' })

  /* ── 日历 ─────────────────────────────────────────────── */
  const c = await newPage(390, 844)
  await c.goto(`${BASE}/#/pages/calendar/calendar`, { waitUntil: 'networkidle0', timeout: 60000 })
  await sleep(1000)
  const scrollInfo = await c.evaluate(() => {
    const sv = document.querySelector('.wk-scroll')
    if (!sv) return null
    const scroller = Array.from(sv.querySelectorAll('*')).find((e) => e.scrollWidth > e.clientWidth + 1)
    return scroller ? { left: Math.round(scroller.scrollLeft), max: scroller.scrollWidth - scroller.clientWidth } : null
  })
  log('week auto-scroll ->', scrollInfo)
  await c.screenshot({ path: '/tmp/work/cal-2.png' })

  // 月视图
  await clickText(c, '月')
  await sleep(500)
  log('month cells=', await c.evaluate(() => document.querySelectorAll('.mcell').length))
  await c.screenshot({ path: '/tmp/work/cal-month.png' })

  // 点下月的 5 号 → 回周视图
  await c.evaluate(() => {
    const cell = Array.from(document.querySelectorAll('.mcell.out')).find((x) => x.querySelector('.dn')?.textContent.trim() === '5')
    cell?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  })
  await sleep(600)
  log('back to week?', await c.evaluate(() => !!document.querySelector('.weekwrap')), 'label=', await c.evaluate(() => document.querySelector('.wk')?.textContent))

  // 点事件块 → 抽屉
  await c.evaluate(() => {
    const ev = document.querySelector('.evbar')
    ev?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  })
  await sleep(500)
  log('cal sheet open?', await c.evaluate(() => !!document.querySelector('.sheet')))
  await c.screenshot({ path: '/tmp/work/cal-sheet.png' })
  await c.click('.sheet .x')
  await sleep(300)

  // 回到今天，安排列表加一条 09:00
  await clickText(c, '今天')
  await sleep(500)
  await c.evaluate(() => document.querySelector('.addrow .ain input')?.scrollIntoView({ block: 'center' }))
  await sleep(200)
  await c.click('.addrow .ain input')
  await c.type('.addrow .ain input', '日历里加一条', { delay: 70 })
  await c.keyboard.press('Enter')
  await sleep(600)
  const added = await c.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('moss.work.dev-a'))
    return d.tasks.filter((t) => t.title === '日历里加一条').map((t) => `${t.date}|${t.when}`)
  })
  log('calendar quick add ->', added, 'events=', await c.evaluate(() => document.querySelectorAll('.evbar').length))
  await c.evaluate(() => document.querySelector('.addrow')?.scrollIntoView({ block: 'center' }))
  await sleep(300)
  await c.screenshot({ path: '/tmp/work/cal-agenda.png' })

  log('ERRORS >>>')
  for (const e of errors.slice(0, 20)) log(e)
} finally {
  await browser.close()
}
