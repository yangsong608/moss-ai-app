#!/usr/bin/env node
/**
 * 同步行映射测试（P1-3）
 *
 * 为什么单独编译再 import：
 *   - `src/core/sync-engine.ts` 依赖 uni storage / 连接层，node 直接 import 会炸；
 *   - 映射已抽到 `src/core/sync-adapt.ts`（纯函数），用本地 tsc 编到临时目录再 require，
 *     测的是**真实实现**，不是复制一份到测试里（复制版必漂）。
 *
 * 覆盖：任务 ↔ 行 双向、笔记 ↔ 行、专注 ↔ 行、when 生成、时间戳格式、游标回退、
 *       冲突副本标题、实体别名。
 *
 * 用法：node scripts/sync-adapter-test.mjs（或 npm run test:sync）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'src/core/sync-adapt.ts')
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc')

/** 编译纯映射模块并加载（--noCheck：只做 emit，不做类型检查，typecheck 由 vue-tsc 负责） */
function loadAdapt() {
  const out = mkdtempSync(join(tmpdir(), 'moss-sync-adapter-'))
  try {
    execFileSync(
      process.execPath,
      [TSC, '--noCheck', '--outDir', out, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck', SOURCE],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    )
    const require = createRequire(import.meta.url)
    return require(join(out, 'sync-adapt.js'))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

let adapt
try {
  ;({ adapt } = loadAdapt())
} catch (error) {
  console.error(`✗ 编译/加载 src/core/sync-adapt.ts 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

/* ─────────── 固定样本 ─────────── */

const AT = new Date(2026, 9, 24, 20, 40, 2).getTime() // 2026-10-24 20:40:02 本地时间
const DAY = '2026-10-24'

function makeTask(patch = {}) {
  return {
    id: 't1',
    title: '评审支付模块重构方案',
    note: '',
    status: 'doing',
    pri: 'high',
    date: DAY,
    when: '9:30',
    tags: ['重构'],
    sub: [],
    done: false,
    dev: '公司-Mac',
    sync: true,
    conflict: false,
    createdAt: AT - 86_400_000,
    updatedAt: AT,
    ...patch,
  }
}

function makeNote(patch = {}) {
  return {
    id: 'n1',
    notebook: '工作',
    title: '同步引擎设计要点',
    content: '# 同步引擎',
    tags: ['同步', '架构'],
    fav: true,
    updatedAt: AT,
    ...patch,
  }
}

function makeFocus(patch = {}) {
  return { id: 'f1', taskId: 't1', minutes: 25, completed: true, startedAt: AT, ...patch }
}

/* ─────────── 断言集 ─────────── */

const CASES = []
const test = (label, fn) => CASES.push({ label, fn })

test('任务 → 行：title/status/priority/date/start/end 全量映射', () => {
  const row = adapt.task.toRow(makeTask())
  assert.equal(row.title, '评审支付模块重构方案')
  assert.equal(row.status, 'doing')
  assert.equal(row.priority, 'high')
  assert.equal(row.date, DAY)
  assert.equal(row.start, '09:30')
  assert.equal(row.end, '')
})

test("任务 → 行：when '9:30' 生成 HH:MM 的 start '09:30'", () => {
  assert.equal(adapt.task.toRow(makeTask({ when: '9:30' })).start, '09:30')
  assert.equal(adapt.task.toRow(makeTask({ when: '14:00' })).start, '14:00')
})

test('任务 → 行：非时刻 when（未排期/今天）不写 start', () => {
  for (const when of ['未排期', '今天', '之后', '截止周五', '']) {
    assert.equal(adapt.task.toRow(makeTask({ when })).start, '', `when=${when} 不该生成 start`)
  }
})

test('任务 → 行：宿主无 when 列，不推送 when', () => {
  const row = adapt.task.toRow(makeTask())
  assert.equal('when' in row, false)
})

test("行 → 任务：start '14:05' 还原 when", () => {
  const task = adapt.task.fromRow({ title: '周报', status: 'next', priority: 'normal', date: DAY, start: '14:05' }, 't2', { updatedAt: AT, dev: '公司-Mac' })
  assert.equal(task.when, '14:05')
})

test("行 → 任务：无 start → when '未排期'", () => {
  const task = adapt.task.fromRow({ title: '整理发票', start: null }, 't3', { updatedAt: AT })
  assert.equal(task.when, '未排期')
  assert.equal(task.date, '')
})

test('行 → 任务：非法 status/priority 回退 next/normal', () => {
  const task = adapt.task.fromRow({ title: 'x', status: 'done', priority: 'urgent' }, 't4', { updatedAt: AT })
  assert.equal(task.status, 'next')
  assert.equal(task.pri, 'normal')
})

test('行 → 任务：title/date/createdAt/updatedAt 映射正确', () => {
  const createdAt = new Date(2026, 9, 20, 8, 0, 0).getTime()
  const task = adapt.task.fromRow(
    { title: '给妈约体检', status: 'waiting', priority: 'low', date: DAY, start: '17:00', createdAt: adapt.ts.format(createdAt) },
    't5',
    { updatedAt: AT, dev: '家里-PC' },
  )
  assert.equal(task.title, '给妈约体检')
  assert.equal(task.status, 'waiting')
  assert.equal(task.pri, 'low')
  assert.equal(task.date, DAY)
  assert.equal(task.createdAt, createdAt)
  assert.equal(task.updatedAt, AT)
  assert.equal(task.dev, '家里-PC')
  assert.equal(task.id, 't5')
})

test('任务往返：task → row → task 保持主要字段（when 数值化后稳定）', () => {
  const task = makeTask()
  const back = adapt.task.fromRow(adapt.task.toRow(task), task.id, { prev: task, updatedAt: task.updatedAt })
  assert.equal(back.title, task.title)
  assert.equal(back.status, task.status)
  assert.equal(back.pri, task.pri)
  assert.equal(back.date, task.date)
  assert.equal(back.when, '09:30') // '9:30' 规范化为 '09:30'
  const again = adapt.task.fromRow(adapt.task.toRow(back), task.id, { prev: back, updatedAt: back.updatedAt })
  assert.equal(again.when, back.when) // 再跑一次稳定
})

test('时间戳格式：YYYY-MM-DD HH:MM:SS，不含 ISO 的 T/Z', () => {
  const text = adapt.ts.format(AT)
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(text.includes('T'), false)
  assert.equal(text.includes('Z'), false)
  assert.equal(text, '2026-10-24 20:40:02')
})

test('时间戳往返：parse(format(ms)) 精确到秒', () => {
  const ms = new Date(2026, 0, 2, 3, 4, 5).getTime()
  assert.equal(adapt.ts.parse(adapt.ts.format(ms)), ms)
  assert.equal(adapt.ts.parse(adapt.ts.format(AT)), AT)
})

test('时间戳解析：兼容分钟精度 / T 分隔 / 纯日期', () => {
  const minute = new Date(2026, 9, 24, 20, 40, 0).getTime()
  assert.equal(adapt.ts.parse('2026-10-24 20:40'), minute)
  assert.equal(adapt.ts.parse('2026-10-24T20:40:00'), minute)
  assert.equal(adapt.ts.parse('2026-10-24'), new Date(2026, 9, 24, 0, 0, 0).getTime())
  assert.equal(adapt.ts.parse(''), 0)
  assert.equal(adapt.ts.parse(null), 0)
})

test('游标回退 5 分钟（重叠加拉）', () => {
  const cursor = adapt.ts.format(AT)
  const since = adapt.ts.overlap(cursor, 5)
  assert.equal(adapt.ts.parse(since), AT - 5 * 60_000)
  assert.match(since, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

test('空游标回退仍为空（首次同步拉全量）', () => {
  assert.equal(adapt.ts.overlap('', 5), '')
  assert.equal(adapt.ts.overlap('0', 5), '')
})

test('笔记 → 行：notebookId/title/content/tags/pinned', () => {
  const row = adapt.note.toRow(makeNote())
  assert.equal(row.notebookId, '工作')
  assert.equal(row.title, '同步引擎设计要点')
  assert.equal(row.content, '# 同步引擎')
  assert.deepEqual(row.tags, ['同步', '架构'])
  assert.equal(row.pinned, true)
})

test('行 → 笔记：notebookId 落到 notebook，pinned → fav', () => {
  const note = adapt.note.fromRow(
    { id: 'n2', notebookId: '生活', title: '周末清单', content: '- 换机油', tags: ['周末'], pinned: false },
    'n2',
    { updatedAt: AT },
  )
  assert.equal(note.notebook, '生活')
  assert.equal(note.title, '周末清单')
  assert.equal(note.content, '- 换机油')
  assert.deepEqual(note.tags, ['周末'])
  assert.equal(note.fav, false)
  assert.equal(note.updatedAt, AT)
})

test('行 → 笔记：notebook 名优先于 notebookId', () => {
  const note = adapt.note.fromRow({ notebook: '学习', notebookId: 'nb-1', title: 'SQLite WAL' }, 'n3', { updatedAt: AT })
  assert.equal(note.notebook, '学习')
})

test('笔记往返：fav/title/content 保持，缺失字段沿用旧值', () => {
  const note = makeNote({ fav: false })
  const back = adapt.note.fromRow(adapt.note.toRow(note), note.id, { prev: note, updatedAt: note.updatedAt })
  assert.equal(back.fav, false)
  assert.equal(back.title, note.title)
  assert.equal(back.content, note.content)
  assert.deepEqual(back.tags, note.tags)
})

test('专注 → 行：startedAt 转时间串，minutes/completed 原样', () => {
  const row = adapt.focus.toRow(makeFocus())
  assert.equal(row.startedAt, '2026-10-24 20:40:02')
  assert.equal(row.minutes, 25)
  assert.equal(row.completed, true)
  assert.equal(row.taskId, 't1')
})

test('行 → 专注：startedAt 解析回 epoch 毫秒', () => {
  const session = adapt.focus.fromRow(
    { id: 'f2', taskId: 't2', startedAt: adapt.ts.format(AT), minutes: 50, completed: false },
    'f2',
    { updatedAt: AT },
  )
  assert.equal(session.startedAt, AT)
  assert.equal(session.minutes, 50)
  assert.equal(session.completed, false)
  assert.equal(session.taskId, 't2')
})

test('行 → 专注：completed 的 1/0 归一为布尔', () => {
  const one = adapt.focus.fromRow({ startedAt: adapt.ts.format(AT), minutes: 25, completed: 1 }, 'f3')
  const zero = adapt.focus.fromRow({ startedAt: adapt.ts.format(AT), minutes: 25, completed: 0 }, 'f4')
  assert.equal(one.completed, true)
  assert.equal(zero.completed, false)
})

test('冲突副本标题：统一「冲突副本：<标题>」前缀', () => {
  assert.equal(adapt.conflictTitle('周报：同步引擎联调结论'), '冲突副本：周报：同步引擎联调结论')
  assert.equal(adapt.conflictTitle('  评审支付  '), '冲突副本：评审支付')
})

test('冲突副本标题：空标题回退「未命名」', () => {
  assert.equal(adapt.conflictTitle(''), '冲突副本：未命名')
  assert.equal(adapt.conflictTitle('   '), '冲突副本：未命名')
})

test('实体别名：focus → focus_sessions，未知实体 → undefined', () => {
  assert.equal(adapt.entityOf('tasks'), 'tasks')
  assert.equal(adapt.entityOf('notes'), 'notes')
  assert.equal(adapt.entityOf('focus_sessions'), 'focus_sessions')
  assert.equal(adapt.entityOf('focus'), 'focus_sessions')
  assert.equal(adapt.entityOf('news_topics'), undefined)
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

console.log(`\n映射断言：${passed}/${CASES.length} 通过`)
if (failures.length > 0) {
  process.exit(1)
}
