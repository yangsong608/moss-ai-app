import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)))
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 200)) })
await page.setViewport({ width: 390, height: 844 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await page.goto('http://localhost:5180/#/pages/news/news', { waitUntil: 'networkidle0', timeout: 60000 })
await sleep(1600)
console.log('before:', await page.$eval('.nh-sub', (el) => el.textContent))
await page.click('.fetch')
for (const t of [200, 800, 1400, 2600]) {
  await sleep(t === 200 ? 200 : 600)
  console.log(`t=${t}`, await page.$eval('.fetch', (el) => el.textContent.trim()), '|', await page.$eval('.nh-sub', (el) => el.textContent.trim()))
}
await browser.close()
