import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:5188'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const errors = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function newPage(width, height) {
  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: width < 820, hasTouch: width < 820 })
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e)}`))
  return page
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  // 1. 今天（手机）
  const today = await newPage(390, 844)
  await today.goto(`${BASE}/#/pages/today/today`, { waitUntil: 'networkidle0', timeout: 60000 })
  await sleep(1200)
  await today.screenshot({ path: '/tmp/work/today-phone.png' })
  console.log('TODAY TEXT >>>')
  console.log((await today.evaluate(() => document.body.innerText)).slice(0, 1200))
  console.log('TODAY SCROLL >>>', await today.evaluate(() => {
    const sv = document.querySelector('uni-scroll-view.ws-body .uni-scroll-view')
    return { w: innerWidth, bodyH: document.body.scrollHeight, scrollW: sv ? sv.scrollWidth : -1 }
  }))

  // 2. 今天（平板）
  const todayTab = await newPage(834, 1112)
  await todayTab.goto(`${BASE}/#/pages/today/today`, { waitUntil: 'networkidle0', timeout: 60000 })
  await sleep(900)
  await todayTab.screenshot({ path: '/tmp/work/today-tablet.png' })

  // 3. 日历（手机）
  const cal = await newPage(390, 844)
  await cal.goto(`${BASE}/#/pages/calendar/calendar`, { waitUntil: 'networkidle0', timeout: 60000 })
  await sleep(1200)
  await cal.screenshot({ path: '/tmp/work/cal-phone.png' })
  console.log('CAL TEXT >>>')
  console.log((await cal.evaluate(() => document.body.innerText)).slice(0, 1200))

  // 4. 日历（平板）
  const calTab = await newPage(834, 1112)
  await calTab.goto(`${BASE}/#/pages/calendar/calendar`, { waitUntil: 'networkidle0', timeout: 60000 })
  await sleep(900)
  await calTab.screenshot({ path: '/tmp/work/cal-tablet.png' })

  console.log('ERRORS >>>')
  for (const e of errors.slice(0, 20)) console.log(e)
} finally {
  await browser.close()
}
