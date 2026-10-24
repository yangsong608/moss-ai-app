#!/usr/bin/env node
/**
 * AI 派发纯逻辑测试（P2-1 + P2-2）
 *
 * 做法与 `scripts/sync-adapter-test.mjs` 一致：用本地 tsc 把 `src/core/ai-dispatch.ts`
 * 编到临时目录再 require，测的是**真实实现**（复制一份到测试里必漂）。
 *
 * 为什么能单独编译：ai-dispatch 上半部分不依赖 uni / vue；真实连接层（link、sync-engine）
 * 只在 `liveAiHost()` 里动态 import，测试不会触发。
 *
 * 覆盖：指令拼装（笔记/资讯）、降级分支、轮询判定、宿主新闻归一化，
 *       以及用假宿主跑通"派发 → 轮询 → 成功"与"离线不派发"。
 *
 * 用法：node scripts/ai-dispatch-test.mjs（或 npm run test:ai）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'src/core/ai-dispatch.ts')
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc')

function loadDispatch() {
  const out = mkdtempSync(join(tmpdir(), 'moss-ai-dispatch-'))
  try {
    execFileSync(
      process.execPath,
      [TSC, '--noCheck', '--outDir', out, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck', SOURCE],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    )
    const require = createRequire(import.meta.url)
    return require(join(out, 'ai-dispatch.js'))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

let ai
try {
  ai = loadDispatch()
} catch (error) {
  console.error(`✗ 编译/加载 src/core/ai-dispatch.ts 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

/* ─────────── 假宿主 ─────────── */

function makeHost(patch = {}) {
  const calls = []
  const state = { noteAt: 1_000, news: [...(patch.news ?? [])], merged: new Set() }
  const host = {
    connected: () => true,
    localOnly: () => false,
    workbenchCap: () => 1,
    sync: async () => {
      calls.push({ method: 'sync' })
      return { ok: true }
    },
    call: async (method, params = {}) => {
      calls.push({ method, params })
      if (method === 'workspace.list') return { workspaces: [{ id: 'ws-1', path: '/tmp/ws-1' }] }
      if (method === 'session.create') return { sessionId: 'sess-1' }
      if (method === 'session.prompt') {
        const text = String(params.text ?? '')
        if (text.includes('workbench_news_publish')) {
          state.news.push({ id: 'ni-new', topicId: 'tp-1', title: '新卡片', url: 'https://example.com/new' })
        } else {
          state.noteAt += 5_000
        }
        return { ok: true }
      }
      if (method === 'wb.news.list') {
        return { topics: [{ id: 'tp-1', title: 'AI 动态' }], items: state.news }
      }
      throw new Error(`未预期的调用：${method}`)
    },
    noteUpdatedAt: () => state.noteAt,
    // newsIds = 本机已合并的卡片（基线由派发前那次 refreshNews 建立）
    newsIds: () => [...state.merged],
    refreshNews: async () => {
      calls.push({ method: 'refreshNews' })
      let added = 0
      for (const item of state.news) {
        if (state.merged.has(item.id)) continue
        state.merged.add(item.id)
        added += 1
      }
      return { added, topics: [{ id: 'tp-1', title: 'AI 动态' }] }
    },
    ...patch.host,
  }
  return { host, calls, state }
}

/* ─────────── 断言集 ─────────── */

const CASES = []
const test = (label, fn) => CASES.push({ label, fn })

test('笔记指令：必须句包含 workbench_note_update 与笔记 id', () => {
  const line = ai.noteUpdateInstruction('n-42')
  assert.equal(line, '调用 workbench_note_update 工具更新笔记 n-42 的标题与正文，保留笔记本/标签/收藏，不要新建笔记。')
  assert.equal(line.includes('n-42'), true)
})

test('笔记 prompt：包含 id、标题、笔记本与"不要新建笔记"', () => {
  const prompt = ai.buildNotePolishPrompt({ noteId: 'n1', title: '同步引擎设计要点', notebook: '工作' })
  assert.equal(prompt.includes('笔记 id：n1'), true)
  assert.equal(prompt.includes('同步引擎设计要点'), true)
  assert.equal(prompt.includes('所属笔记本：工作'), true)
  assert.equal(prompt.includes('workbench_note_update'), true)
  assert.equal(prompt.includes('不要新建笔记'), true)
})

test('笔记 prompt：追加要求只在填写时出现', () => {
  const plain = ai.buildNotePolishPrompt({ noteId: 'n1', title: '标题' })
  assert.equal(plain.includes('用户追加要求'), false)
  const asked = ai.buildNotePolishPrompt({ noteId: 'n1', title: '标题', extra: '压缩到 300 字' })
  assert.equal(asked.includes('用户追加要求：压缩到 300 字'), true)
})

test('资讯 prompt：包含订阅、工具名与解析出的 topicId', () => {
  const prompt = ai.buildNewsFetchPrompt({ topic: 'AI 动态', topicId: 'tp-1', count: 8 })
  assert.equal(prompt.includes('AI 动态'), true)
  assert.equal(prompt.includes('workbench_news_publish'), true)
  assert.equal(prompt.includes('topicId）：tp-1'), true)
  assert.equal(prompt.includes('最近 7 天'), true)
  assert.equal(prompt.includes('挑 8 条以内'), true)
})

test('资讯 prompt：没有 topicId 时用订阅名兜底并写明未同步', () => {
  const prompt = ai.buildNewsFetchPrompt({ topic: '前端' })
  assert.equal(prompt.includes('订阅 id 未同步到本机'), true)
  assert.equal(prompt.includes('topicId 直接使用订阅名「前端」'), true)
  assert.equal(prompt.includes('topicId 原样使用「前端」'), true)
})

test('降级：未连接 → offline，文案包含"需连接设备"与"本机保存"', () => {
  const gate = ai.gateOf({ connected: () => false, localOnly: () => false, workbenchCap: () => 1 })
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'offline')
  assert.equal(gate.message.includes('需连接设备'), true)
  assert.equal(gate.message.includes('本机保存'), true)
})

test('降级：「仅本机」数据域 → local-only', () => {
  const gate = ai.gateOf({ connected: () => true, localOnly: () => true, workbenchCap: () => 1 })
  assert.equal(gate.code, 'local-only')
  assert.equal(gate.message.includes('不会同步到设备'), true)
})

test('降级：caps.workbench = 0 → no-workbench；未知 caps 放行', () => {
  const noWb = ai.gateOf({ connected: () => true, localOnly: () => false, workbenchCap: () => 0 })
  assert.equal(noWb.code, 'no-workbench')
  assert.equal(noWb.message.includes('caps 不含 workbench'), true)
  assert.equal(ai.gateOf({ connected: () => true, localOnly: () => false, workbenchCap: () => undefined }).ok, true)
  assert.equal(ai.gateOf({ connected: () => true, localOnly: () => false, workbenchCap: () => 1 }).ok, true)
})

test('笔记轮询判定：updatedAt 严格变大才算回写', () => {
  assert.equal(ai.notePollDecision(1000, 2000, 1), 'changed')
  assert.equal(ai.notePollDecision(2000, 2000, 1), 'retry')
  assert.equal(ai.notePollDecision(2000, 1500, 1), 'retry')
  assert.equal(ai.notePollDecision(1000, undefined, 1), 'retry')
})

test('笔记轮询判定：到达最大次数从未变化 → timeout', () => {
  assert.equal(ai.notePollDecision(1000, 1000, 11, 12), 'retry')
  assert.equal(ai.notePollDecision(1000, 1000, 12, 12), 'timeout')
  // 第 12 次刚好变化，仍应算成功
  assert.equal(ai.notePollDecision(1000, 1001, 12, 12), 'changed')
})

test('资讯轮询判定：出现基线外的新 id 即成功', () => {
  assert.equal(ai.newsPollDecision(['a', 'b'], ['a', 'b', 'c'], 1), 'changed')
  assert.equal(ai.newsPollDecision(['a'], ['a'], 1), 'retry')
  assert.equal(ai.newsPollDecision([], [], 12, 12), 'timeout')
  assert.equal(ai.newsPollDecision(['a'], ['a'], 11, 12), 'retry')
})

test('新闻归一化：aiSummary 优先、topicId 还原主题名、空标题丢弃、重复 id 去重', () => {
  const cards = ai.normalizeNewsItems(
    [
      { id: 'ni-1', topicId: 'tp-1', title: '标题一', url: 'https://a', source: '来源', aiSummary: 'AI 总结', summary: '一句话', publishedAt: '2026-10-24' },
      { id: 'ni-1', title: '重复 id' },
      { id: 'ni-2', title: '   ' },
    ],
    [{ id: 'tp-1', title: 'AI 动态' }],
  )
  assert.equal(cards.length, 1)
  assert.equal(cards[0].topic, 'AI 动态')
  assert.equal(cards[0].summary, 'AI 总结')
  assert.equal(cards[0].when, '2026-10-24')
  assert.equal(cards[0].url, 'https://a')
})

test('编排：离线时不发任何 RPC，直接降级', async () => {
  const { host, calls } = makeHost({ host: { connected: () => false } })
  const outcome = await ai.dispatchNotePolish(host, { noteId: 'n1' })
  assert.equal(outcome.status, 'degraded')
  assert.equal(outcome.code, 'offline')
  assert.equal(calls.length, 0)
})

test('编排：笔记成功派发 → workspace.list / session.create / session.prompt 顺序正确', async () => {
  const { host, calls } = makeHost()
  const outcome = await ai.dispatchNotePolish(host, { noteId: 'n1', title: '标题', notebook: '工作' }, { intervalMs: 0 })
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.sessionId, 'sess-1')
  const methods = calls.map((c) => c.method).filter((m) => m !== 'sync' && m !== 'refreshNews')
  assert.deepEqual(methods.slice(0, 3), ['workspace.list', 'session.create', 'session.prompt'])
  const promptCall = calls.find((c) => c.method === 'session.prompt')
  assert.equal(String(promptCall.params.text).includes('笔记 id：n1'), true)
  assert.equal(promptCall.params.sessionId, 'sess-1')
  assert.equal(typeof promptCall.params.requestId, 'string')
  // 会话创建必须带 workspaceId（协议要求 workspaceId / cwd 至少一个）
  const createCall = calls.find((c) => c.method === 'session.create')
  assert.equal(createCall.params.workspaceId, 'ws-1')
})

test('编排：笔记一直不变化 → 轮询到上限后 timeout，不谎报成功', async () => {
  const { host } = makeHost({
    host: {
      call: async (method) => {
        if (method === 'workspace.list') return { workspaces: [{ id: 'ws-1' }] }
        if (method === 'session.create') return { sessionId: 'sess-1' }
        if (method === 'session.prompt') return { ok: true } // 不推进 updatedAt
        throw new Error(method)
      },
    },
  })
  const outcome = await ai.dispatchNotePolish(host, { noteId: 'n1' }, { intervalMs: 0, maxAttempts: 3 })
  assert.equal(outcome.status, 'timeout')
  assert.equal(outcome.message.includes('已在设备上执行'), true)
})

test('编排：设备没有工作区 → failed，不创建会话', async () => {
  const { host, calls } = makeHost({
    host: {
      call: async (method) => {
        if (method === 'workspace.list') return { workspaces: [] }
        throw new Error(`不应调用 ${method}`)
      },
    },
  })
  const outcome = await ai.dispatchNotePolish(host, { noteId: 'n1' }, { intervalMs: 0 })
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.code, 'no-workspace')
  assert.equal(calls.some((c) => c.method === 'session.create'), false)
})

test('编排：资讯检索成功 → topicId 从宿主订阅表解析，出现新卡片即成功', async () => {
  // 宿主已有一张旧卡：必须被纳入基线，不能算成本次新增
  const { host, calls, state } = makeHost({
    news: [{ id: 'ni-old', topicId: 'tp-1', title: '旧卡片', url: 'https://old' }],
  })
  const outcome = await ai.dispatchNewsFetch(host, { topic: 'AI 动态' }, { intervalMs: 0 })
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.added, 1)
  const promptCall = calls.find((c) => c.method === 'session.prompt')
  assert.equal(String(promptCall.params.text).includes('workbench_news_publish'), true)
  // 基线里旧卡被 refreshNews 合并后，本机应有 2 张（旧 + 新）
  assert.deepEqual(state.news.map((n) => n.id).sort(), ['ni-new', 'ni-old'])
})

test('编排：资讯检索无新卡片 → timeout，口径与笔记一致', async () => {
  const { host } = makeHost({
    news: [],
    host: {
      call: async (method) => {
        if (method === 'workspace.list') return { workspaces: [{ id: 'ws-1' }] }
        if (method === 'session.create') return { sessionId: 'sess-1' }
        if (method === 'session.prompt') return { ok: true }
        if (method === 'wb.news.list') return { topics: [{ id: 'tp-1', title: 'AI 动态' }], items: [] }
        throw new Error(method)
      },
    },
  })
  const outcome = await ai.dispatchNewsFetch(host, { topic: 'AI 动态' }, { intervalMs: 0, maxAttempts: 2 })
  assert.equal(outcome.status, 'timeout')
  assert.equal(outcome.message.includes('已在设备上执行'), true)
})

/* ─────────── 执行 ─────────── */

let passed = 0
const failures = []
for (const item of CASES) {
  try {
    await item.fn()
    passed += 1
    console.log(`  ✓ ${item.label}`)
  } catch (error) {
    failures.push({ label: item.label, error })
    console.log(`  ✗ ${item.label}`)
    console.log(`      ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

console.log(`\nAI 派发断言：${passed}/${CASES.length} 通过`)
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`\n失败：${failure.label}`)
    console.log(failure.error instanceof Error ? failure.error.stack : String(failure.error))
  }
  process.exit(1)
}
