/**
 * 纹理遮挡检测 —— 在真实页面里检查文字与按钮是否被纹理图形压住。
 *
 * 做法：
 *   1. 把每张纹理图当作"非透明区域"的来源，按其 anchor 矩形还原到卡片坐标系
 *   2. 遍历卡片里所有可见文字/按钮，取它们的矩形
 *   3. 判断两者是否相交
 *
 * 比"看截图"更可靠：截图只能看出"明显压住"，这种检测能查出
 * "擦边"和"压住按钮"的情况。
 *
 * 用法：node tools/moss-render/overlap-today.mjs
 */

import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const BASE = process.env.H5_BASE ?? 'http://127.0.0.1:5188'
const OUT = '/tmp/ui-shots'
const HERE = new URL('.', import.meta.url).pathname

/**
 * anchor 从 card_specs.py 读真值，不在这里抄一份。
 *
 * 抄的副本已经和规格表漂移过一轮（quick / caldate 还是旧值），
 * 照着副本判重叠，量的是"图形在旧位置有没有压字" ——
 * 图形早就搬走了，结论全是"无重叠"，等于没检。
 */
function readAnchors() {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(HERE)})
import card_specs
out = {}
for s in card_specs.CARD_SPECS:
    if s.get('page') == 'today':
        out[s['cls']] = s.get('anchor')
print(json.dumps(out))
`
  const raw = execFileSync('/Users/ysmac/.workbuddy/binaries/python/envs/default/bin/python3',
    ['-c', py], { encoding: 'utf-8' })
  return JSON.parse(raw)
}

const ANCHORS = readAnchors()

// 整幅模式下图形只保留的带（calpage 的装订条）
const KEEP_BAND = {
  '.calpage': [0.125, 0.008, 0.875, 0.108],
}

await mkdir(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--allow-insecure-localhost'],
})

const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('dsh-link/prefs', JSON.stringify({ skinMode: 'moss', light: false, lite: false })) } catch {}
})
await page.goto(BASE + '/#/pages/today/today', { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 2500))

const report = await page.evaluate((anchors, keepBand) => {
  const out = []

  for (const [sel, anchor] of Object.entries(anchors)) {
    const card = document.querySelector(sel)
    if (!card) { out.push({ sel, skip: 'not found' }); continue }
    const cr = card.getBoundingClientRect()
    if (cr.width === 0) { out.push({ sel, skip: 'hidden' }); continue }

    // 纹理图的实际盒子：<image> 元素是铺满整卡的，
    // 但**图形本身**只占 anchor 矩形（其余是透明），
    // 所以判定必须用 anchor 矩形，否则会把整卡都算成重叠。
    const tex = card.querySelector('img.tex, uni-image.tex, .tex')
    if (!tex) { out.push({ sel, skip: 'no tex' }); continue }
    const tr = tex.getBoundingClientRect()

    // 图形在卡片内的实际矩形
    let gx0, gy0, gx1, gy1
    if (anchor) {
      gx0 = tr.left + anchor[0] * tr.width
      gy0 = tr.top + anchor[1] * tr.height
      gx1 = tr.left + anchor[2] * tr.width
      gy1 = tr.top + anchor[3] * tr.height
    } else {
      // 整幅模式：图形保留在 safe 之外
      const safe = keepBand[sel]
      if (safe) {
        // safe 是"被遮罩保护"的矩形，图形在它之外 → 用 safe 的补集
        // 简化成四条带，逐条判定太繁琐；这里改成：
        // 图形区域 = safe 的下方（台历头的下面）
        gx0 = tr.left
        gy0 = tr.top + safe[3] * tr.height
        gx1 = tr.right
        gy1 = tr.bottom
      } else {
        gx0 = tr.left; gy0 = tr.top; gx1 = tr.right; gy1 = tr.bottom
      }
    }

    // 找出卡片内所有文字节点与可点控件
    const items = []
    card.querySelectorAll('*').forEach((n) => {
      if (n.classList.contains('tex')) return
      const r = n.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      const cs = getComputedStyle(n)
      const hasText = [...n.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim())
      const isBtn = n.className?.toString?.().includes('btn')
      if (!hasText && !isBtn) return

      // **关键**：如果这个元素被一层不透明背景的祖先盖住，
      // 它就不会被纹理影响（纹理在更下层）。
      // 判定：从元素往上走到卡片，看有没有"不透明背景"的中间层。
      let covered = false
      let p = n.parentElement
      while (p && p !== card) {
        const pcs = getComputedStyle(p)
        const bg = pcs.backgroundColor
        const m = bg.match(/rgba?\(([^)]+)\)/)
        if (m) {
          const parts = m[1].split(',').map((x) => parseFloat(x))
          const a = parts.length > 3 ? parts[3] : 1
          if (a > 0.85) { covered = true; break }
        }
        p = p.parentElement
      }
      if (covered) return

      items.push({
        cls: (n.className?.toString?.() || n.tagName).slice(0, 28),
        text: (n.textContent || '').trim().slice(0, 16),
        x0: r.left, y0: r.top, x1: r.right, y1: r.bottom,
      })
    })

    // 交叠检测：文字矩形与纹理盒的重叠面积占比
    const hits = []
    for (const it of items) {
      const ox = Math.max(0, Math.min(it.x1, gx1) - Math.max(it.x0, gx0))
      const oy = Math.max(0, Math.min(it.y1, gy1) - Math.max(it.y0, gy0))
      const area = (it.x1 - it.x0) * (it.y1 - it.y0)
      const ratio = area > 0 ? (ox * oy) / area : 0
      if (ratio > 0.02) hits.push({ ...it, ratio: +(ratio * 100).toFixed(1) })
    }
    hits.sort((a, b) => b.ratio - a.ratio)
    out.push({ sel, texBox: [Math.round(gx0 - cr.left), Math.round(gy0 - cr.top), Math.round(gx1 - gx0), Math.round(gy1 - gy0)], hits })
  }
  return out
}, ANCHORS, KEEP_BAND)

let bad = 0
for (const r of report) {
  if (r.skip) { console.log(`■ ${r.sel}: ${r.skip}`); continue }
  const worst = r.hits[0]
  const status = !worst ? '✓ 无重叠' : (worst.ratio > 35 ? '✗ 严重重叠' : '⚠ 轻微擦边')
  if (worst && worst.ratio > 35) bad++
  console.log(`■ ${r.sel}  纹理盒 ${r.texBox.join('×')}  ${status}`)
  for (const h of r.hits.slice(0, 4)) {
    console.log(`    ${String(h.ratio).padStart(5)}%  ${h.cls.padEnd(24)} "${h.text}"`)
  }
}

console.log(bad ? `\n✗ ${bad} 处严重重叠` : '\n✓ 无严重重叠')
await browser.close()
