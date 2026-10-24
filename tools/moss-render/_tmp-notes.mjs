import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = '/tmp/moss-work-shots'
mkdirSync(OUT, { recursive: true })
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// desktop layout metrics
const d = await browser.newPage()
await d.setViewport({ width: 1000, height: 820, deviceScaleFactor: 2 })
await d.goto('http://localhost:5180/#/pages/notes/notes', { waitUntil: 'networkidle0', timeout: 60000 })
await sleep(1600)
console.log('desktop boxes:', await d.evaluate(() => {
  const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } }
  return { body: box('.ws-body'), editor: box('.editor'), foot: box('.ed-foot'), tabbar: box('.ws-tabbar') }
}))
await d.screenshot({ path: `${OUT}/notes-d2.png` })

// create + delete on mobile
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)))
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
await page.goto('http://localhost:5180/#/pages/notes/notes', { waitUntil: 'networkidle0', timeout: 60000 })
await sleep(1400)
await page.click('.head-new')
await sleep(500)
await page.screenshot({ path: `${OUT}/notes-create.png` })
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('.cs-nb')).find((n) => n.textContent.includes('新笔记本'))
  el?.click()
})
await sleep(250)
await page.type('.cs-input input', '灵感')
await page.screenshot({ path: `${OUT}/notes-create-new.png` })
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('.cs-actions .btn')).find((n) => n.textContent.includes('创建并编辑'))
  el?.click()
})
await sleep(500)
console.log('after create:', await page.evaluate(() => ({
  count: JSON.parse(localStorage.getItem('moss.work.dev-a')).notes.length,
  nb: JSON.parse(localStorage.getItem('moss.work.dev-a')).notes[0].notebook,
  editor: !!document.querySelector('.edit-col'),
  title: document.querySelector('.ed-title input')?.value,
})))
await page.screenshot({ path: `${OUT}/notes-created.png` })
// delete
await page.click('.ed-del')
await sleep(500)
await page.screenshot({ path: `${OUT}/notes-delete.png` })
const modalText = await page.evaluate(() => document.querySelector('.uni-modal')?.innerText ?? 'NO MODAL')
console.log('modal:', modalText.replace(/\n/g, ' | '))
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('.uni-modal__btn'))
  const ok = btns.find((b) => b.textContent.includes('删除'))
  ok?.click()
})
await sleep(500)
console.log('after delete:', await page.evaluate(() => ({
  count: JSON.parse(localStorage.getItem('moss.work.dev-a')).notes.length,
  editor: !!document.querySelector('.edit-col'),
})))
await page.screenshot({ path: `${OUT}/notes-deleted.png` })
await browser.close()
