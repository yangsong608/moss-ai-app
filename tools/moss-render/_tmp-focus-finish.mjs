import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)))
await page.setViewport({ width: 390, height: 844 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await page.goto('http://localhost:5180/#/pages/focus/focus', { waitUntil: 'networkidle0', timeout: 60000 })
await sleep(1500)
// preset 15 + start
await page.evaluate(() => document.querySelectorAll('.preset')[0]?.click())
await sleep(200)
await page.evaluate(() => document.querySelector('.timer-btns .btn.primary')?.click())
await sleep(1200)
// 跳过 16 分钟：改写 Date.now，让 tick 认为已到点
await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 16 * 60 * 1000 })
await sleep(800)
console.log('after finish:', await page.evaluate(() => ({
  time: document.querySelector('.ring-time')?.textContent,
  state: document.querySelector('.ring-state')?.textContent,
  primary: document.querySelector('.timer-btns .btn.primary')?.textContent,
  stat: Array.from(document.querySelectorAll('.stat-v')).map((e) => e.textContent),
  focus: JSON.parse(localStorage.getItem('moss.work.dev-a')).focus.slice(-1),
})))
await page.screenshot({ path: '/tmp/moss-work-shots/focus-done.png' })

// 中断：重新加载后跑 90 秒再重置
await page.reload({ waitUntil: 'networkidle0' })
await sleep(1400)
await page.evaluate(() => document.querySelectorAll('.preset')[0]?.click())
await sleep(200)
await page.evaluate(() => document.querySelector('.timer-btns .btn.primary')?.click())
await sleep(1000)
await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 90 * 1000 })
await sleep(500)
await page.evaluate(() => document.querySelectorAll('.timer-btns .btn')[1]?.click())
await sleep(500)
console.log('after interrupt:', await page.evaluate(() => ({
  time: document.querySelector('.ring-time')?.textContent,
  focus: JSON.parse(localStorage.getItem('moss.work.dev-a')).focus.slice(-1),
})))
await browser.close()
