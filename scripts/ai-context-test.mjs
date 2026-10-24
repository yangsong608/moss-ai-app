#!/usr/bin/env node
/**
 * AI 上下文携带测试（P2-3）
 *
 * 做法与 sync-adapter-test 一致：用本地 tsc 把 `src/core/ai-context.ts` 编到临时目录再 require，
 * 测的是真实实现（不是复制一份到测试里）。`ai-context.ts` 在没有 uni 的环境退化为进程内 Map，
 * 所以 node 里能直接跑 stash / take。
 *
 * 覆盖：TTL 常量、stash/take 往返、读取即清、单槽覆盖、过期清理、边界、prompt 文案、
 *       空白折叠与截断、非法数据拒绝。
 *
 * 用法：node scripts/ai-context-test.mjs（或 npm run test:ai-context）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'src/core/ai-context.ts')
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc')

function loadContextModule() {
  const out = mkdtempSync(join(tmpdir(), 'moss-ai-context-'))
  try {
    execFileSync(
      process.execPath,
      [TSC, '--noCheck', '--outDir', out, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck', SOURCE],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    )
    const require = createRequire(import.meta.url)
    return require(join(out, 'ai-context.js'))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

let mod
try {
  mod = loadContextModule()
} catch (error) {
  console.error(`✗ 编译/加载 src/core/ai-context.ts 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const { stashContext, takeContext, contextPrompt, contextLabel, AI_CONTEXT_TTL_MS, AI_CONTEXT_KEY } = mod

/* ─────────── 固定样本 ─────────── */

const T0 = new Date(2026, 9, 24, 21, 0, 0).getTime()
const MINUTE = 60_000

const TASK = {
  kind: 'task',
  id: 'T-01',
  title: '评审支付模块重构方案',
  excerpt: '重点看退款链路与幂等键',
}

const NOTE = {
  kind: 'note',
  id: 'N-07',
  title: '同步引擎设计要点',
  excerpt: '# 同步引擎 冲突默认保留两份',
}

/** 每个用例开始前清槽，避免上一例的残留。 */
function reset() {
  takeContext(0)
}

const CASES = []
const test = (label, fn) => CASES.push({ label, fn })

/* ─────────── 断言集 ─────────── */

test('TTL 是 30 分钟，key 带命名空间', () => {
  assert.equal(AI_CONTEXT_TTL_MS, 30 * MINUTE)
  assert.equal(AI_CONTEXT_KEY, 'moss/ai-context')
})

test('空槽 take 返回 undefined', () => {
  reset()
  assert.equal(takeContext(T0), undefined)
})

test('stash → take 往返：kind / id / title / excerpt 全保留', () => {
  reset()
  stashContext(TASK, T0)
  assert.deepEqual(takeContext(T0), TASK)
})

test('读取即清：第二次 take 返回 undefined', () => {
  reset()
  stashContext(TASK, T0)
  assert.notEqual(takeContext(T0), undefined)
  assert.equal(takeContext(T0), undefined)
})

test('单槽：后一次 stash 覆盖前一次', () => {
  reset()
  stashContext(TASK, T0)
  stashContext(NOTE, T0 + MINUTE)
  const got = takeContext(T0 + MINUTE)
  assert.equal(got.kind, 'note')
  assert.equal(got.id, 'N-07')
})

test('30 分钟内有效', () => {
  reset()
  stashContext(TASK, T0)
  const got = takeContext(T0 + 29 * MINUTE)
  assert.equal(got.id, 'T-01')
})

test('超过 30 分钟过期：返回 undefined 且清槽', () => {
  reset()
  stashContext(TASK, T0)
  assert.equal(takeContext(T0 + 30 * MINUTE + 1), undefined)
  // 过期值已被清掉：把时钟拨回去也读不出来
  assert.equal(takeContext(T0), undefined)
})

test('正好 30 分钟边界仍有效（> 才过期）', () => {
  reset()
  stashContext(TASK, T0)
  const got = takeContext(T0 + 30 * MINUTE)
  assert.equal(got.id, 'T-01')
})

test('过期后重新 stash 可以正常读', () => {
  reset()
  stashContext(TASK, T0)
  takeContext(T0 + 60 * MINUTE)
  stashContext(NOTE, T0 + 61 * MINUTE)
  assert.equal(takeContext(T0 + 61 * MINUTE).id, 'N-07')
})

test('非法上下文（未知 kind / 空 id）不落槽', () => {
  reset()
  stashContext({ kind: 'unknown', id: 'x', title: 'x' }, T0)
  assert.equal(takeContext(T0), undefined)
  stashContext({ kind: 'task', id: '   ', title: 'x' }, T0)
  assert.equal(takeContext(T0), undefined)
})

test('标题缺失时归一为「未命名任务」', () => {
  reset()
  stashContext({ kind: 'task', id: 'T-09' }, T0)
  assert.equal(takeContext(T0).title, '未命名任务')
})

test('上下文缺失字段：prompt 只有标题/id，不带冒号后的空白', () => {
  reset()
  stashContext({ kind: 'task', id: 'T-01', title: '评审支付模块重构方案' }, T0)
  assert.equal(
    contextPrompt(takeContext(T0)),
    '关于任务《评审支付模块重构方案》（id=T-01）：',
  )
})

test('任务 prompt 文案：关于任务《…》（id=…）：摘要', () => {
  assert.equal(
    contextPrompt(TASK),
    '关于任务《评审支付模块重构方案》（id=T-01）：重点看退款链路与幂等键',
  )
})

test('笔记 prompt 文案：关于笔记《…》（id=…）：摘要', () => {
  assert.equal(
    contextPrompt(NOTE),
    '关于笔记《同步引擎设计要点》（id=N-07）：# 同步引擎 冲突默认保留两份',
  )
})

test('prompt 摘要压成单行（不出现换行）', () => {
  const prompt = contextPrompt({
    kind: 'note',
    id: 'N-1',
    title: '多行\n标题',
    excerpt: '第一行\n\n第二行\t第三行',
  })
  assert.equal(prompt.includes('\n'), false)
  assert.equal(prompt.includes('\t'), false)
  assert.match(prompt, /第一行 第二行 第三行/)
})

test('prompt 长摘要截断并以省略号结尾', () => {
  const prompt = contextPrompt({ kind: 'task', id: 'T-1', title: '长摘要', excerpt: '甲'.repeat(400) })
  assert.equal(prompt.startsWith('关于任务《长摘要》（id=T-1）：'), true)
  assert.equal(prompt.endsWith('…'), true)
  assert.equal(prompt.length < 400, true)
})

test('chip 文案：引用：任务《…》/ 笔记《…》', () => {
  assert.equal(contextLabel(TASK), '引用：任务《评审支付模块重构方案》')
  assert.equal(contextLabel(NOTE), '引用：笔记《同步引擎设计要点》')
})

test('非法上下文：prompt / chip 返回空串，调用方按无上下文处理', () => {
  assert.equal(contextPrompt({ kind: 'task', id: '', title: 'x' }), '')
  assert.equal(contextLabel({ kind: 'oops', id: 'x', title: 'x' }), '')
})

/* ── 存储降级：H5 的 window.uni 只是 {}，不能把上下文写丢 ── */

function fakeLocalStorage() {
  const store = new Map()
  return {
    store,
    api: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)) },
      removeItem: (k) => { store.delete(k) },
    },
  }
}

test('uni 是空占位对象（H5 stub）时退回 localStorage，不静默丢数据', () => {
  reset()
  const ls = fakeLocalStorage()
  globalThis.uni = {}
  globalThis.localStorage = ls.api
  try {
    stashContext(TASK, T0)
    assert.equal(ls.store.has(AI_CONTEXT_KEY), true)
    assert.deepEqual(takeContext(T0), TASK)
    assert.equal(ls.store.has(AI_CONTEXT_KEY), false)
  } finally {
    delete globalThis.uni
    delete globalThis.localStorage
  }
})

test('uni storage 可用时优先走 uni，不碰 localStorage', () => {
  reset()
  const uniStore = new Map()
  const ls = fakeLocalStorage()
  globalThis.uni = {
    getStorageSync: (k) => (uniStore.has(k) ? uniStore.get(k) : ''),
    setStorageSync: (k, v) => { uniStore.set(k, String(v)) },
    removeStorageSync: (k) => { uniStore.delete(k) },
  }
  globalThis.localStorage = ls.api
  try {
    stashContext(NOTE, T0)
    assert.equal(uniStore.has(AI_CONTEXT_KEY), true)
    assert.equal(ls.store.has(AI_CONTEXT_KEY), false)
    assert.equal(takeContext(T0).id, 'N-07')
    assert.equal(uniStore.has(AI_CONTEXT_KEY), false)
  } finally {
    delete globalThis.uni
    delete globalThis.localStorage
  }
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

console.log(`\n上下文断言：${passed}/${CASES.length} 通过`)
if (failures.length > 0) {
  process.exit(1)
}
