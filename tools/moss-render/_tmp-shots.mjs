import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = '/tmp/moss-work-shots'
mkdirSync(OUT, { recursive: true })

const pages = ['focus', 'notes', 'news', 'mine']
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })

for (const [w, h, tag] of [[390, 844, 'm'], [1000, 820, 'd']]) {
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)))
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 })
  for (const name of pages) {
    try {
      await page.goto(`http://localhost:5180/#/pages/${name}/${name}`, { waitUntil: 'networkidle0', timeout: 60000 })
      await new Promise((r) => setTimeout(r, 2200))
      await page.screenshot({ path: `${OUT}/${name}-${tag}.png`, fullPage: true })
      const info = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 300), h: document.body.scrollHeight }))
      console.log(`--- ${name}-${tag} h=${info.h} ---\n${info.text}\n`)
    } catch (e) {
      console.log(`FAIL ${name}-${tag}: ${String(e).slice(0, 200)}`)
    }
  }
  await page.close()
}
await browser.close()
