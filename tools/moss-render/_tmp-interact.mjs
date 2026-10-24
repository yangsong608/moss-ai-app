import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = '/tmp/moss-work-shots'
mkdirSync(OUT, { recursive: true })
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)))
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const go = async (name) => {
  await page.goto(`http://localhost:5180/#/pages/${name}/${name}`, { waitUntil: 'networkidle0', timeout: 60000 })
  await sleep(1600)
}

// 1. focus interaction
await go('focus')
console.log('focus initial:', await page.$eval('.ring-time', (el) => el.textContent))
await page.click('.preset:nth-child(1)').catch((e) => console.log('preset click fail', e.message))
await page.click('.timer-btns .btn.primary')
await sleep(2200)
console.log('focus running:', await page.$eval('.ring-time', (el) => el.textContent), await page.$eval('.ring-state', (el) => el.textContent))
console.log('ring style:', await page.$eval('.ring', (el) => el.style.background))
await page.screenshot({ path: `${OUT}/focus-running.png` })
await page.click('.timer-btns .btn.primary')
console.log('focus paused:', await page.$eval('.ring-state', (el) => el.textContent), await page.$eval('.timer-btns .btn.primary', (el) => el.textContent))
await page.click('.task-pick')
await sleep(400)
await page.screenshot({ path: `${OUT}/focus-picker.png` })
const rows = await page.$$('.pick-row')
console.log('picker rows:', rows.length)
if (rows[2]) await rows[2].click()
await sleep(300)
console.log('picked task:', await page.$eval('.task-name', (el) => el.textContent))
await page.click('.timer-btns .btn:nth-child(2)')
await sleep(300)
console.log('focus reset:', await page.$eval('.ring-time', (el) => el.textContent), await page.$eval('.ring-state', (el) => el.textContent))

// 2. notes mobile editor + autosave
await go('notes')
await page.click('.note-card')
await sleep(600)
console.log('editor visible:', await page.$eval('.edit-col', (el) => getComputedStyle(el).position))
await page.screenshot({ path: `${OUT}/notes-editor-m.png` })
const titleInput = await page.$('.ed-title input')
await titleInput.click({ clickCount: 3 })
await page.keyboard.type('（改）同步引擎设计要点')
await sleep(900)
const saved = await page.evaluate(() => {
  const raw = localStorage.getItem('moss.work.dev-a')
  if (!raw) return 'NO STORAGE'
  const d = JSON.parse(raw)
  return d.notes.find((n) => n.id === 'n1')?.title
})
console.log('autosaved title:', saved)
console.log('word count:', await page.$eval('.ed-wc', (el) => el.textContent))
await page.screenshot({ path: `${OUT}/notes-editor-typed.png` })

// 3. news fetch
await go('news')
await page.click('.fetch')
await sleep(300)
console.log('fetch loading:', await page.$eval('.fetch', (el) => el.textContent.trim()), await page.$eval('.fetch', (el) => getComputedStyle(el).opacity))
await sleep(1300)
console.log('fetch done:', await page.$eval('.fetch', (el) => el.textContent.trim()), await page.$eval('.nh-sub', (el) => el.textContent.trim()))
await page.screenshot({ path: `${OUT}/news-fetched.png` })

// 4. mine theme toggles
await go('mine')
await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.seg-i'))
  const target = items.find((el) => el.textContent.includes('550W'))
  target?.click()
})
await sleep(700)
console.log('skin class:', await page.$eval('.ws', (el) => el.className))
await page.screenshot({ path: `${OUT}/mine-550w.png` })
await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.seg-i'))
  const target = items.find((el) => el.textContent.includes('浅色'))
  target?.click()
})
await sleep(700)
console.log('theme class:', await page.$eval('.ws', (el) => el.className))
await page.screenshot({ path: `${OUT}/mine-light.png` })

await browser.close()
