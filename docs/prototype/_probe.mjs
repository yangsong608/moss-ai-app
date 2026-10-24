/**
 * 新增交互探针（重做后自查，不替代 verify.mjs）：
 *   node _probe.mjs
 * 覆盖「今天」「我的」两屏新交互 + 全程 JS 报错捕获。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire('/Volumes/软件目录/work/zkxh/deepseek/dsh-link-suite/docs/prototype/package.json')
const puppeteer = require('puppeteer-core')

const HERE = dirname(fileURLToPath(import.meta.url))
const URL = `file://${resolve(HERE, 'index.html')}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
let failed = 0
const ok = (c, l) => { console.log(`${c ? '  ✓' : '  ✗'} ${l}`); if (!c) failed += 1 }

for (const [name, width, height] of [['phone', 390, 844], ['tablet-landscape', 1280, 800]]) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, defaultViewport: null,
    args: [`--window-size=${width},${height}`, '--hide-scrollbars', '--no-sandbox'], timeout: 60000,
  })
  const page = await browser.newPage()
  await new Promise((r) => setTimeout(r, 300))
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await new Promise((r) => setTimeout(r, 350))
  console.log(`\n■ ${name} ${width}×${height} · 新交互探针`)

  const r1 = await page.evaluate(() => {
    const out = {}
    // 1 分组折叠
    const head = document.querySelector('.ghead')
    head.click()
    out.collapsed = !!document.querySelector('.gcard.collapsed')
    head.click()
    // 2 筛选
    document.querySelector('#btnFilter').click()
    out.filterPop = document.querySelector('#popFilter').classList.contains('on')
    document.querySelector('[data-filter="high"]').click()
    out.filtered = [...document.querySelectorAll('.trow')].length > 0 && document.querySelectorAll('.trow').length < 8
    out.filterDot = !document.querySelector('#filterDot').hidden
    document.querySelector('#btnFilter').click()
    document.querySelector('[data-filter="all"]').click()
    // 3 清已完成
    const before = document.querySelectorAll('.trow').length
    document.querySelector('#progRing').click()
    out.clearModal = document.querySelector('#modal').classList.contains('on')
    document.querySelector('#btnClearDone').click()
    out.cleared = document.querySelectorAll('.trow').length < before
    // 4 看板横滑（手机）
    document.querySelector('[data-view="board"]').click()
    const board = document.querySelector('.board')
    out.board = !document.querySelector('#taskBoard').hidden
    out.boardScroll = getComputedStyle(board).display === 'flex' ? board.scrollWidth > board.clientWidth : true
    document.querySelector('[data-view="list"]').click()
    return out
  })
  ok(r1.collapsed, '分组折叠/展开')
  ok(r1.filterPop && r1.filtered && r1.filterDot, '筛选弹层 + 过滤生效 + 角标')
  ok(r1.clearModal && r1.cleared, '点击进度 → 清已完成（modal 确认）')
  ok(r1.board && r1.boardScroll, '看板视图（手机列横滑）')

  const r2 = await page.evaluate(() => {
    const out = {}
    // 5 详情：改状态/优先级/改期/子待办
    document.querySelector('.trow').click()
    out.drawer = document.querySelector('#drawer').classList.contains('on') || window.innerWidth >= 1100
    document.querySelector('[data-act="set-status"][data-v="doing"]').click()
    out.status = !!document.querySelector('[data-act="set-status"][data-v="doing"].on')
    document.querySelector('[data-act="set-pri"][data-v="高"]').click()
    out.pri = !!document.querySelector('[data-act="set-pri"][data-v="高"].on')
    document.querySelector('[data-act="reschedule"]').click()
    out.reschedPop = document.querySelector('#popResched').classList.contains('on')
    document.querySelector('[data-resched="明天 · 10/25 10:00"]').click()
    out.rescheduled = document.body.innerText.includes('明天 · 10/25 10:00')
    const subBefore = document.querySelectorAll('.sub').length
    const si = document.querySelector('input[data-act="sub-add"]')
    si.value = '探针子待办'
    si.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    out.subAdded = document.querySelectorAll('.sub').length === subBefore + 1
    // 6 冲突卡：查看差异 / 保留两边
    const diffBtn = document.querySelector('[data-act="conflict-diff"]')
    out.hasConflict = !!diffBtn
    if (diffBtn) {
      diffBtn.click()
      out.diffModal = document.querySelector('#modal').classList.contains('on')
      document.querySelector('[data-act="conflict-keep"]').click()
      out.resolved = !!document.querySelector('.conflict-card.resolved')
    }
    // 7 AI 拆解
    document.querySelector('[data-act="ai-split"]').click()
    out.aiModal = document.querySelector('#modal').classList.contains('on')
    return out
  })
  ok(r2.drawer, '任务详情打开（抽屉/右栏）')
  ok(r2.status && r2.pri, '详情控件：状态分段 + 优先级色点')
  ok(r2.reschedPop && r2.rescheduled, '改期弹层 → 日期 chip 更新')
  ok(r2.subAdded, '子待办回车添加')
  ok(r2.hasConflict && r2.diffModal && r2.resolved, '冲突卡：查看差异 modal + 保留两边')
  ok(r2.aiModal, '让 AI 拆解 → 完善中 modal')
  await new Promise((r) => setTimeout(r, 1500))

  const r3 = await page.evaluate(() => {
    const out = {}
    document.querySelector('[data-act="modal-close"]')?.click()
    // 8 我的：入口 → 子屏 → 返回
    document.querySelector('[data-go="me"]').click()
    out.home = !document.querySelector('#meHome').hidden && document.querySelector('#meNotes').hidden
    document.querySelector('.me-entry[data-me="notes"]').click()
    out.notes = !document.querySelector('#meNotes').hidden
    // 笔记卡片 + 编辑器
    document.querySelector('[data-note="n2"]').click()
    out.editor = !!document.querySelector('[data-act="ai-polish"]')
    out.full = window.innerWidth < 820 ? document.querySelector('#noteEditor').classList.contains('fson') : true
    document.querySelector('[data-act="note-mode"][data-v="edit"]').click()
    out.src = !!document.querySelector('textarea[data-act="note-src"]')
    const w1 = document.querySelector('#noteWords').textContent
    const ta = document.querySelector('textarea[data-act="note-src"]')
    ta.value = ta.value + ' 补一段'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    out.words = document.querySelector('#noteWords').textContent !== w1
    document.querySelector('[data-act="to-task"]').click()
    out.toTask = document.querySelector('#toasts').children.length > 0
    document.querySelector('[data-act="export-md"]').click()
    if (window.innerWidth < 820) document.querySelector('[data-act="note-close"]').click()
    // 设置子屏
    document.querySelector('[data-act="note-mode"][data-v="preview"]')?.click()
    document.querySelector('#meNotes [data-me="settings"]').click()
    out.settings = !document.querySelector('#meSettings').hidden
    out.rows = document.querySelectorAll('#meSettings .setrow').length
    // 设备子屏（data-go 路由）
    document.querySelector('[data-go="devices"]').click()
    out.devices = !document.querySelector('#meDevices').hidden
    out.pair = !!document.querySelector('#btnPairNew')
    document.querySelector('#meDevices [data-me="home"]').click()
    out.back = !document.querySelector('#meHome').hidden
    // 快速记录设备徽标
    document.querySelector('#btnQuickDev').click()
    document.querySelector('[data-qdev="仅本机"]').click()
    out.qdev = document.querySelector('#quickDevName').textContent === '仅本机'
    return out
  })
  ok(r3.home && r3.notes, '我的：大入口 → 笔记子屏')
  ok(r3.editor && r3.full, '笔记卡片 → 编辑器（手机全屏）')
  ok(r3.src && r3.words, '预览/编辑切换 + 字数实时更新')
  ok(r3.toTask, '转为任务 / 导出 MD（toast）')
  ok(r3.settings && r3.rows >= 8, `设置子屏分组列表（${r3.rows} 行）`)
  ok(r3.devices && r3.pair, '设备子屏（data-go=devices 路由）+ 配对新设备')
  ok(r3.back, '子屏返回入口')
  ok(r3.qdev, '快速记录目标设备徽标可换')
  ok(errors.length === 0, `全程无 JS 报错${errors.length ? '（' + errors[0] + '）' : ''}`)
  await browser.close()
}
console.log(failed === 0 ? '\n✅ 新交互探针全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
