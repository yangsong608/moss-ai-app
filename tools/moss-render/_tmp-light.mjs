import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (const name of ['focus', 'notes', 'news', 'mine']) {
  await page.goto(`http://localhost:5180/#/pages/${name}/${name}`, { waitUntil: 'networkidle0', timeout: 60000 })
  await sleep(1400)
  const cls = await page.$eval('.ws', (el) => el.className)
  if (!cls.includes('is-light')) { await page.click('.ws-theme'); await sleep(500) }
  await page.screenshot({ path: `/tmp/moss-work-shots/${name}-light2.png` })
  console.log(name, await page.$eval('.ws', (el) => el.className))
}
// mine: check active skin under auto
await page.goto('http://localhost:5180/#/pages/mine/mine', { waitUntil: 'networkidle0', timeout: 60000 })
await sleep(1200)
console.log('mine skin segs:', await page.$$eval('.seg-i', (els) => els.map((e) => ({ t: e.textContent.trim(), on: e.className.includes('on') }))))
await browser.close()
