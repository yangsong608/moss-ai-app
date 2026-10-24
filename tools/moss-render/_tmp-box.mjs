import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const page = await browser.newPage()
await page.setViewport({ width: 1000, height: 820 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await page.goto('http://localhost:5180/#/pages/notes/notes', { waitUntil: 'networkidle0', timeout: 60000 })
await sleep(1600)
console.log(await page.evaluate(() => {
  const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height } }
  return {
    ws: box('.ws'), body: box('.ws-body'), inner: box('.ws-inner'), editor: box('.editor'), foot: box('.ed-foot'), tabbar: box('.ws-tabbar'), workspace: box('.workspace'),
    scrollTop: document.querySelector('.ws-body')?.scrollTop,
    scrollHeight: document.querySelector('.ws-body')?.scrollHeight,
    clientHeight: document.querySelector('.ws-body')?.clientHeight,
  }
}))
await browser.close()
