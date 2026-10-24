#!/usr/bin/env node
/**
 * 农历换算测试（日历卡片头部用）
 *
 * 做法与 sync-adapter-test.mjs 一致：用本地 tsc 把 `src/core/lunar.ts` 编到临时目录再
 * require，测的是**真实实现**，不会出现"测试里抄一份表、实现里漂了"的情况。
 *
 * 覆盖：春节 / 除夕、闰月（2025 闰六月）、月末（三十）与月首、标签格式（初一只显示月名、
 *       闰月初一带「闰」）、表边界（1900-01-31 与 2101-01-28）、越界返回空、非法日期。
 *
 * 用法：node scripts/lunar-test.mjs（或 npm run test:lunar）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'src/core/lunar.ts')
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc')

/** 编译纯计算模块并加载（--noCheck：只 emit，类型检查交给 vue-tsc） */
function loadLunar() {
  const out = mkdtempSync(join(tmpdir(), 'moss-lunar-'))
  try {
    execFileSync(
      process.execPath,
      [TSC, '--noCheck', '--outDir', out, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck', SOURCE],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    )
    const require = createRequire(import.meta.url)
    return require(join(out, 'lunar.js'))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

let lunar
try {
  lunar = loadLunar()
} catch (error) {
  console.error(`✗ 编译/加载 src/core/lunar.ts 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

/* ─────────── 工具 ─────────── */

/** 本地时区构造：与页面里 `new Date(y, m - 1, d)` 完全一致 */
const day = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const CASES = []
const test = (label, fn) => CASES.push({ label, fn })

/* ─────────── 春节 / 除夕 ─────────── */

test('2024-02-10 春节 → 正月初一', () => {
  const l = lunar.solarToLunar(day('2024-02-10'))
  assert.equal(l.year, 2024)
  assert.equal(l.month, 1)
  assert.equal(l.day, 1)
  assert.equal(l.monthName, '正月')
  assert.equal(l.dayName, '初一')
  assert.equal(l.isLeap, false)
})

test('2026-02-17 春节 → 正月初一（标签「正月」）', () => {
  assert.deepEqual(
    { year: lunar.solarToLunar(day('2026-02-17')).year, label: lunar.lunarDayLabel(day('2026-02-17')) },
    { year: 2026, label: '正月' },
  )
})

test('2026-02-16 除夕 → 上一年腊月廿九', () => {
  const l = lunar.solarToLunar(day('2026-02-16'))
  assert.equal(l.year, 2025)
  assert.equal(l.month, 12)
  assert.equal(l.dayName, '廿九')
  assert.equal(lunar.lunarDayLabel(day('2026-02-16')), '腊月廿九')
})

/* ─────────── 平日 / 月末 ─────────── */

test('2026-10-25 → 九月十六（在九月，标签格式「九月十六」）', () => {
  const l = lunar.solarToLunar(day('2026-10-25'))
  assert.equal(l.month, 9)
  assert.equal(l.monthName, '九月')
  assert.equal(l.day, 16)
  assert.equal(lunar.lunarDayLabel(day('2026-10-25')), '九月十六')
})

test('2026-11-08 是九月三十：月末 day = 30，标签「九月三十」', () => {
  const l = lunar.solarToLunar(day('2026-11-08'))
  assert.equal(l.month, 9)
  assert.equal(l.day, 30)
  assert.equal(l.dayName, '三十')
  assert.equal(lunar.lunarDayLabel(day('2026-11-08')), '九月三十')
})

test('2026-11-09 紧接月末 → 十月初一', () => {
  assert.equal(lunar.lunarDayLabel(day('2026-11-09')), '十月')
})

/* ─────────── 闰月（2025 闰六月） ─────────── */

test('2025-07-25 闰六月初一：isLeap = true，标签「闰六月」', () => {
  const l = lunar.solarToLunar(day('2025-07-25'))
  assert.equal(l.year, 2025)
  assert.equal(l.month, 6)
  assert.equal(l.day, 1)
  assert.equal(l.isLeap, true)
  assert.equal(l.monthName, '六月')
  assert.equal(lunar.lunarDayLabel(day('2025-07-25')), '闰六月')
})

test('2025-06-25 正常六月初一：isLeap = false，标签「六月」', () => {
  const l = lunar.solarToLunar(day('2025-06-25'))
  assert.equal(l.month, 6)
  assert.equal(l.day, 1)
  assert.equal(l.isLeap, false)
  assert.equal(lunar.lunarDayLabel(day('2025-06-25')), '六月')
})

test('2025-07-24 闰月前一天是六月三十（闰月紧跟同名月）', () => {
  assert.equal(lunar.lunarDayLabel(day('2025-07-24')), '六月三十')
})

test('2025-08-23 闰六月之后回到七月初一', () => {
  const l = lunar.solarToLunar(day('2025-08-23'))
  assert.equal(l.month, 7)
  assert.equal(l.day, 1)
  assert.equal(l.isLeap, false)
  assert.equal(lunar.lunarDayLabel(day('2025-08-23')), '七月')
})

/* ─────────── 标签格式 ─────────── */

test('标签格式：初一只显示月名，其余「月名 + 日名」', () => {
  const samples = [
    ['2026-02-17', '正月'],
    ['2026-02-18', '正月初二'],
    ['2026-03-18', '正月三十'],
    ['2026-03-19', '二月'],
    ['2025-08-22', '闰六月廿九'],
    ['2025-08-23', '七月'],
  ]
  for (const [iso, label] of samples) assert.equal(lunar.lunarDayLabel(day(iso)), label, iso)
})

test('标签格式：闰月前缀只出现在闰月，正常月不带「闰」', () => {
  const leap = lunar.lunarDayLabel(day('2025-07-26'))
  const normal = lunar.lunarDayLabel(day('2025-08-24'))
  assert.match(leap, /^闰六月/)
  assert.equal(normal.startsWith('闰'), false)
})

/* ─────────── 表边界 / 越界 ─────────── */

test('表下界：1900-01-31 是正月初一（基准日）', () => {
  assert.equal(lunar.lunarDayLabel(day('1900-01-31')), '正月')
  assert.equal(lunar.solarToLunar(day('1900-01-30')), null)
  assert.equal(lunar.lunarDayLabel(day('1899-12-31')), '')
})

test('表上界：2101-01-28 仍在表内，2101-01-29 起越界', () => {
  assert.equal(lunar.lunarDayLabel(day('2101-01-28')), '腊月廿九')
  assert.equal(lunar.solarToLunar(day('2101-01-29')), null)
  assert.equal(lunar.lunarDayLabel(day('2101-01-29')), '')
  assert.equal(lunar.lunarDayLabel(day('2200-01-01')), '')
})

test('非法日期返回 null / 空标签，不抛错', () => {
  assert.equal(lunar.solarToLunar(new Date(NaN)), null)
  assert.equal(lunar.lunarDayLabel(new Date('not-a-date')), '')
})

/* ─────────── 执行 ─────────── */

let passed = 0
const failures = []
for (const item of CASES) {
  try {
    item.fn()
    passed += 1
    console.log(`  ✓ ${item.label}`)
  } catch (error) {
    failures.push({ label: item.label, error })
    console.log(`  ✗ ${item.label}`)
    console.log(`      ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

console.log(`\n农历断言：${passed}/${CASES.length} 通过`)
if (failures.length > 0) {
  process.exit(1)
}
