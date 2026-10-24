import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (const name of ['focus', 'notes', 'news', 'mine', 'focus']) {
  await page.goto(`http://localhost:5180/#/pages/${name}/${name}`, { waitUntil: 'networkidle0', timeout: 60000 })
  await sleep(1200)
  const info = await page.evaluate(() => ({
    cls: document.querySelector('.ws')?.className,
    prefs: localStorage.getItem('dsh-link/prefs'),
    osTheme: (uni && uni.getSystemInfoSync) ? uni.getSystemInfoSync().osTheme : 'n/a',
  }))
  console.log(name, JSON.stringify(info))
}
await browser.close()
