/**
 * AI 派发层（P2-1 + P2-2）：把手机上的「AI 完善」「立即检索」交给设备侧的 DSH agent。
 *
 * 分工：
 *   - 本文件上半部分是**纯逻辑**：指令拼装、降级判定、轮询判定、宿主新闻归一化。
 *     无 uni / vue 依赖，`scripts/ai-dispatch-test.mjs` 编译这一个文件就能测（同
 *     `sync-adapt.ts` 的约定：测试测真实实现，不复制一份）。
 *   - 下半部分是**编排**：host 接口由调用方注入（`AiHost`），真实实现见
 *     `liveAiHost()`——它通过 `currentLink()` / `syncNow()` 接线，绝不自己开 socket。
 *
 * 为什么不直接在这里 import sync-engine / link：
 *   - 它们依赖 uni storage 与 vue 响应式，node 里 import 会直接炸，纯逻辑就没法测；
 *   - 动态 import 把真实依赖推迟到点击时，钩子函数与测试都不碰网络。
 *
 * 三条硬约束（与 docs/02 §「手机说、电脑干、手机看结果」一致）：
 *   1. 派发前先推一轮，保证笔记/订阅在宿主侧可见；离线直接降级，不假装成功。
 *   2. caps 不含 workbench 或未连接：不派发（提示只在本机保存）。
 *   3. 派发成功 ≠ 回写成功：必须轮询拉回该行的 `updatedAt` 变化（笔记）
 *      或新闻增量（资讯）才算完成；超时如实说"已在设备上执行，稍后自动同步"。
 */

import type { NewsItem } from './workbench'

/* ─────────── 常量（轮询策略集中在这里，便于测试与调整） ─────────── */

/** 轮询间隔：5s 一次。太密会把宿主和手机电量当燃料，太疏用户以为没反应。 */
export const AI_POLL_INTERVAL_MS = 5_000
/** 最多 12 次 ≈ 60s：agent 完成一次笔记完善通常 10–40s。 */
export const AI_POLL_MAX_ATTEMPTS = 12

/* ─────────── 宿主接口（可注入 = 可测） ─────────── */

/** caps.workbench：1 支持，0 宿主没装工作台，undefined 未知（按"尝试"处理） */
export type WorkbenchCap = 0 | 1 | undefined

/** syncNow() 的最小投影（不 import sync-engine 的 SyncResult，避免循环依赖）。 */
export interface AiSyncResult {
  ok: boolean
  reason?: string
  error?: string
}

/**
 * 派发用到的协议方法名（以 `@dsh-link/protocol` 的 `METHODS` 为准）。
 *
 * 收敛成联合类型而不是 string：调用处写错方法名，`vue-tsc` 会当场报错；
 * 同时让纯逻辑层不必在运行时依赖协议包。
 */
export type AiDispatchMethod = 'workspace.list' | 'session.create' | 'session.prompt' | 'wb.news.list'

export interface HostNewsTopic {
  id?: string
  title?: string
}

/** 宿主 `wb.news.list` 的条目形状（字段可能缺失，归一化时容错）。 */
export interface HostNewsItem {
  id?: string
  topicId?: string
  topic?: string
  title?: string
  url?: string
  source?: string
  publishedAt?: string
  fetchedAt?: string
  summary?: string
  aiSummary?: string
}

export interface HostNewsRefresh {
  /** 本次合并进本机的新卡片数 */
  added: number
  /** 宿主订阅表：用来把「订阅名」解析成 `workbench_news_publish` 要的 topicId */
  topics: readonly HostNewsTopic[]
}

/**
 * 派发所需的全部宿主能力。
 *
 * 只暴露"派发流程需要的十件事"，页面与测试都可以给一份实现；真实实现见
 * `liveAiHost()`（唯一一处 `currentLink().call(...)`）。
 */
export interface AiHost {
  /** 当前是否已连上设备（online，不是 connecting） */
  connected(): boolean
  /** 当前数据域是否「仅本机」（dev-local）——这种域按定义不过网 */
  localOnly(): boolean
  /** 设备 caps.workbench */
  workbenchCap(): WorkbenchCap
  /** 复用 sync-engine 的 push → pull 一轮 */
  sync(): Promise<AiSyncResult>
  /** 经当前连接调用协议方法（内部用 `currentLink().call(...)`） */
  call<T = unknown>(method: AiDispatchMethod, params?: Record<string, unknown>): Promise<T>
  /** 本机这篇笔记的 updatedAt（毫秒）；不存在返回 undefined */
  noteUpdatedAt(noteId: string): number | undefined
  /** 本机资讯卡片的全部 id（用于判定"新卡片出现"） */
  newsIds(): readonly string[]
  /**
   * 从宿主拉一次新闻快照并合并到本机：
   *   - 合并前先做一次，把宿主已有的卡片纳入基线（否则会把旧卡误判成本次新增）；
   *   - 返回 null 表示宿主没有 `wb.news.list`（老版本），此时只能靠同步超时收尾。
   */
  refreshNews(): Promise<HostNewsRefresh | null>
}

/* ─────────── 降级判定（纯函数） ─────────── */

export type GateCode = 'ok' | 'offline' | 'local-only' | 'no-workbench'

export interface Gate {
  ok: boolean
  code: GateCode
  message: string
}

/** 两处共用的降级文案：离线时按钮仍可点，但明确告知只有本机保存。 */
export const OFFLINE_MESSAGE = '需连接设备：该操作由设备上的 DSH agent 执行。当前未连接，内容只在本机保存。'
export const LOCAL_ONLY_MESSAGE = '当前是「仅本机」数据域，不会同步到设备。请先连接配对设备再试，内容只在本机保存。'
export const NO_WORKBENCH_MESSAGE = '设备未安装工作台插件（caps 不含 workbench），无法派发 AI 任务。内容只在本机保存。'

/**
 * 派发前闸门：未连接 / 仅本机 / caps 不支持 → 不派发。
 *
 * 顺序有讲究：先看连接（用户最容易理解的原因），再看数据域，最后看插件能力。
 */
export function gateOf(host: Pick<AiHost, 'connected' | 'localOnly' | 'workbenchCap'>): Gate {
  if (!host.connected()) return { ok: false, code: 'offline', message: OFFLINE_MESSAGE }
  if (host.localOnly()) return { ok: false, code: 'local-only', message: LOCAL_ONLY_MESSAGE }
  if (host.workbenchCap() === 0) return { ok: false, code: 'no-workbench', message: NO_WORKBENCH_MESSAGE }
  return { ok: true, code: 'ok', message: '' }
}

/* ─────────── 指令拼装（纯函数） ─────────── */

/** 笔记回写的**必须**指令句：id 内联，工具名与"不要新建笔记"都在，避免 agent 自由发挥。 */
export function noteUpdateInstruction(noteId: string): string {
  return `调用 workbench_note_update 工具更新笔记 ${noteId} 的标题与正文，保留笔记本/标签/收藏，不要新建笔记。`
}

export interface NotePolishRequest {
  noteId: string
  title?: string
  notebook?: string
  /** 用户在「按要求完善」里填的追加要求 */
  extra?: string
}

/** 笔记「AI 完善」派发的完整 prompt。 */
export function buildNotePolishPrompt(req: NotePolishRequest): string {
  const noteId = req.noteId.trim()
  const title = (req.title ?? '').trim() || '未命名笔记'
  const lines: string[] = [
    '这是手机端发来的「AI 完善」任务，请直接执行，不要反问。',
    '',
    `笔记 id：${noteId}`,
    `原标题：${title}`,
  ]
  const notebook = (req.notebook ?? '').trim()
  if (notebook !== '') lines.push(`所属笔记本：${notebook}`)
  lines.push(
    '',
    '要求：',
    `1. ${noteUpdateInstruction(noteId)}`,
    '2. 只改进标题与正文：结构更清晰、要点完整、可直接照着做；原文没有的事实不要臆造，缺失处标「待补充」。',
    '3. 正文保持 Markdown 纯文本；不要改动笔记本、标签、收藏，也不要删除后重建。',
  )
  const extra = (req.extra ?? '').trim()
  if (extra !== '') lines.push(`4. 用户追加要求：${extra}`)
  lines.push('', '完成后用一句话说明改了什么；不要调用其他写工具，不要新建笔记。')
  return lines.join('\n')
}

export interface NewsFetchRequest {
  /** 订阅主题名（App 里就是 topic 字段） */
  topic: string
  /** 从同步的 news_topics 解析出的 id；没有则用主题名兜底 */
  topicId?: string
  /** 本次最多写回几条（宿主工具上限 20） */
  count?: number
}

function clampCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 6
  return Math.min(20, Math.max(1, Math.round(value)))
}

/** 资讯「立即检索」派发的完整 prompt。 */
export function buildNewsFetchPrompt(req: NewsFetchRequest): string {
  const topic = req.topic.trim() || '资讯'
  const topicId = (req.topicId ?? '').trim()
  const count = clampCount(req.count)
  const idLine = topicId !== ''
    ? `订阅 id（topicId）：${topicId}`
    : `订阅 id 未同步到本机：topicId 直接使用订阅名「${topic}」`
  return [
    '这是手机端发来的「立即检索」任务，请直接执行，不要反问。',
    '',
    `订阅主题：${topic}`,
    idLine,
    '',
    '要求：',
    `1. 用可用的检索工具搜索「${topic}」最近 7 天的最新资讯，挑 ${count} 条以内最有价值的。`,
    '2. 每条必须有可核实的原文 http/https 链接；没有链接或无法确认的一律丢弃，绝不编造 URL。',
    `3. 调用 workbench_news_publish 工具写回：topicId 原样使用「${topicId !== '' ? topicId : topic}」，items 每项包含 title、url、source、publishedAt（YYYY-MM-DD）与 summary（≤60 字中文）。有把握时补 aiSummary（100–180 字中文，说明事件、关键数据与影响）。`,
    '4. 没有新内容就传空数组，不要为了凑数编造；写回返回「未知订阅」时在回答里说明，不要新建订阅。',
    '完成后用一句话说明写入几条；不要调用其他写工具。',
  ].join('\n')
}

/* ─────────── 轮询判定（纯函数） ─────────── */

export type PollDecision = 'changed' | 'retry' | 'timeout'

/**
 * 笔记是否已回写。
 *
 * `baseline` 是派发后、轮询前读到的本地 `updatedAt`；只有**严格变大**才算变。
 * 判断不看 sync 的返回值：本地行被 pull 更新才是用户能看到的事实。
 */
export function notePollDecision(
  baseline: number | undefined,
  current: number | undefined,
  attempt: number,
  maxAttempts = AI_POLL_MAX_ATTEMPTS,
): PollDecision {
  if (typeof current === 'number' && Number.isFinite(current)) {
    const base = typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : 0
    if (current > base) return 'changed'
  }
  return attempt >= maxAttempts ? 'timeout' : 'retry'
}

/** 资讯是否出现新卡片：出现任何一个基线里没有的 id 即成功。 */
export function newsPollDecision(
  known: readonly string[],
  current: readonly string[],
  attempt: number,
  maxAttempts = AI_POLL_MAX_ATTEMPTS,
): PollDecision {
  const seen = new Set(known)
  if (current.some((id) => id.length > 0 && !seen.has(id))) return 'changed'
  return attempt >= maxAttempts ? 'timeout' : 'retry'
}

/* ─────────── 宿主新闻 → 本地卡片（纯函数） ─────────── */

function pickText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function newsWhen(raw: HostNewsItem): string {
  const published = pickText(raw.publishedAt)
  if (/^\d{4}-\d{2}-\d{2}/.test(published)) return published.slice(0, 10)
  const fetched = pickText(raw.fetchedAt)
  if (fetched !== '') {
    // 宿主落库的是 `YYYY-MM-DD HH:MM:SS` 本地时间；换成 T 再解析，避免被当 UTC
    const d = new Date(fetched.includes('T') ? fetched : fetched.replace(' ', 'T'))
    if (!Number.isNaN(d.getTime())) return `${d.getMonth() + 1}/${d.getDate()}`
  }
  return '刚刚'
}

/**
 * 把 `wb.news.list` 的条目归一成 App 的卡片模型：
 *   - `aiSummary` 优先做正文（卡片是"AI 摘要即正文"）；
 *   - `topicId` 用订阅表还原成可读的主题名；
 *   - id 缺失时用 topic/url/title 生成稳定 id，避免每次刷新都判成"新卡片"。
 */
export function normalizeNewsItems(
  items: readonly HostNewsItem[],
  topics: readonly HostNewsTopic[],
): NewsItem[] {
  const topicNames = new Map<string, string>()
  for (const topic of topics) {
    const id = pickText(topic.id)
    const title = pickText(topic.title)
    if (id !== '' && title !== '') topicNames.set(id, title)
  }

  const out: NewsItem[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const title = pickText(raw.title)
    if (title === '') continue
    const topicId = pickText(raw.topicId)
    const topic = topicNames.get(topicId) ?? (pickText(raw.topic) || topicId || '订阅')
    const url = pickText(raw.url)
    const id = pickText(raw.id) || `host-${topicId}-${url || title}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      topic,
      title,
      summary: pickText(raw.aiSummary) || pickText(raw.summary),
      source: pickText(raw.source),
      when: newsWhen(raw),
      url,
    })
  }
  return out
}

/* ─────────── 编排 ─────────── */

export interface DispatchOptions {
  intervalMs?: number
  maxAttempts?: number
  /** 页面卸载时置 true，最多再等一个 tick 就退出（不把 60s 拖到后台） */
  shouldStop?: () => boolean
  /** 测试可注入 0 延迟 */
  sleep?: (ms: number) => Promise<void>
}

export interface DispatchOutcome {
  status: 'done' | 'timeout' | 'degraded' | 'failed' | 'cancelled'
  /** ok / timeout / offline / no-workbench / local-only / … */
  code: string
  message: string
  sessionId?: string
  /** 资讯成功时新增的卡片数 */
  added?: number
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms))
  })
}

interface WorkspaceLike {
  id?: string
  path?: string
  name?: string
}

async function createSessionForDispatch(
  host: AiHost,
  tag: string,
): Promise<{ sessionId: string } | { error: DispatchOutcome }> {
  const listed = await host.call<{ workspaces?: readonly WorkspaceLike[] }>('workspace.list')
  const workspaces = Array.isArray(listed?.workspaces) ? listed.workspaces : []
  const workspace = workspaces.find((w) => pickText(w?.id) !== '' || pickText(w?.path) !== '')
  if (workspace === undefined) {
    return { error: { status: 'failed', code: 'no-workspace', message: '设备上没有可用工作区，无法创建会话。请先在设备上打开一个项目。' } }
  }
  // 协议最低要求：workspaceId 与 cwd 至少给一个（见 dsh-link gateway 的 session.create）
  const params: Record<string, unknown> = pickText(workspace.id) !== ''
    ? { workspaceId: pickText(workspace.id) }
    : { cwd: pickText(workspace.path) }
  const created = await host.call<{ sessionId?: string }>('session.create', params)
  const sessionId = pickText(created?.sessionId)
  if (sessionId === '') {
    return { error: { status: 'failed', code: 'no-session', message: `设备没有返回会话 id，${tag}未派发。` } }
  }
  return { sessionId }
}

/** 派发失败 / 降级的统一包装（保留可读中文，页面直接展示）。 */
function failure(code: string, message: string, sessionId?: string): DispatchOutcome {
  return { status: 'failed', code, message, ...(sessionId === undefined ? {} : { sessionId }) }
}

/**
 * 笔记「AI 完善」：确保已推送 → 建会话 → 发指令 → 轮询直到 `updatedAt` 变化。
 *
 * 超时不是失败：agent 可能还在跑，宿主会在完成后通过下一次同步带回来。
 */
export async function dispatchNotePolish(
  host: AiHost,
  req: NotePolishRequest,
  options: DispatchOptions = {},
): Promise<DispatchOutcome> {
  const gate = gateOf(host)
  if (!gate.ok) return { status: 'degraded', code: gate.code, message: gate.message }

  // 1. 先推一轮：agent 在宿主侧必须能读到这篇笔记
  let first: AiSyncResult
  try {
    first = await host.sync()
  } catch (error) {
    return failure('sync', `同步到设备失败：${errorText(error)}。内容只在本机保存。`)
  }
  if (!first.ok && first.reason !== 'busy') {
    if (first.reason === 'offline') return { status: 'degraded', code: 'offline', message: OFFLINE_MESSAGE }
    return failure('sync', `同步到设备失败：${first.error ?? '未知错误'}。内容只在本机保存。`)
  }

  // 2. 基线在推送之后取：否则首轮 pull 带来的 updatedAt 变化会被误判成"AI 已回写"
  const baseline = host.noteUpdatedAt(req.noteId)
  if (baseline === undefined) {
    return failure('note-missing', '本机找不到这篇笔记（可能已被删除），未派发。')
  }

  // 3. 会话：工作区取第一个（协议要求 workspaceId 或 cwd 至少一个）
  let sessionId = ''
  try {
    const session = await createSessionForDispatch(host, 'AI 完善')
    if ('error' in session) return session.error
    sessionId = session.sessionId
    await host.call('session.prompt', {
      sessionId,
      text: buildNotePolishPrompt(req),
      requestId: `moss-note-${req.noteId}-${Date.now()}`,
    })
  } catch (error) {
    return failure('dispatch', `派发失败：${errorText(error)}`, sessionId)
  }

  // 4. 轮询：每 5s 推拉一轮，看本地这行的 updatedAt 是否被远端更新吃掉
  const interval = Math.max(0, options.intervalMs ?? AI_POLL_INTERVAL_MS)
  const maxAttempts = Math.max(1, options.maxAttempts ?? AI_POLL_MAX_ATTEMPTS)
  const sleep = options.sleep ?? delay
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.shouldStop?.() === true) {
      return { status: 'cancelled', code: 'cancelled', message: '已停止等待；任务已在设备上执行，完成后会自动同步。', sessionId }
    }
    await sleep(interval)
    try {
      await host.sync()
    } catch {
      // 单次同步失败不终止等待：网络恢复后下一 tick 会补上
    }
    const decision = notePollDecision(baseline, host.noteUpdatedAt(req.noteId), attempt, maxAttempts)
    if (decision === 'changed') {
      return { status: 'done', code: 'ok', message: 'AI 完善已回写，并同步到本机。', sessionId }
    }
    if (decision === 'timeout') break
  }
  return {
    status: 'timeout',
    code: 'timeout',
    message: '已在设备上执行，稍后自动同步；也可以稍后手动点顶栏同步。',
    sessionId,
  }
}

/**
 * 资讯「立即检索」：确保订阅已推送 → 建会话 → 发指令 → 轮询等待新卡片。
 *
 * 为什么轮询里除了 `syncNow()` 还要 `refreshNews()`：
 * dsh-workbench 的增量同步**不包含 news_items**（docs/sync-protocol.md §「不参与同步」），
 * 新增卡片只能通过 `wb.news.list` 拿到。所以策略是：每次 tick 先按约定 syncNow()
 * （推 topics / 收其它实体），再拉一次新闻快照合并到本机，出现基线之外的 id 即成功。
 */
export async function dispatchNewsFetch(
  host: AiHost,
  req: NewsFetchRequest,
  options: DispatchOptions = {},
): Promise<DispatchOutcome> {
  const gate = gateOf(host)
  if (!gate.ok) return { status: 'degraded', code: gate.code, message: gate.message }

  let first: AiSyncResult
  try {
    first = await host.sync()
  } catch (error) {
    return failure('sync', `同步到设备失败：${errorText(error)}。内容只在本机保存。`)
  }
  if (!first.ok && first.reason !== 'busy') {
    if (first.reason === 'offline') return { status: 'degraded', code: 'offline', message: OFFLINE_MESSAGE }
    return failure('sync', `同步到设备失败：${first.error ?? '未知错误'}。内容只在本机保存。`)
  }

  // 基线前先吸收宿主已有卡片（否则第一次 refresh 会把旧卡当成本次新增）
  let topics: readonly HostNewsTopic[] = []
  try {
    const pre = await host.refreshNews()
    if (pre !== null) topics = pre.topics
  } catch {
    // 老宿主没有新闻读取接口：继续派发，收尾时按超时提示
  }
  const known = [...host.newsIds()]

  // topicId：先从宿主订阅表按标题解析，找不到就用主题名兜底
  let topicId = pickText(req.topicId)
  if (topicId === '') {
    const hit = topics.find((t) => pickText(t.title) === req.topic.trim())
    if (hit !== undefined) topicId = pickText(hit.id)
  }

  let sessionId = ''
  try {
    const session = await createSessionForDispatch(host, '资讯检索')
    if ('error' in session) return session.error
    sessionId = session.sessionId
    await host.call('session.prompt', {
      sessionId,
      text: buildNewsFetchPrompt({ ...req, ...(topicId === '' ? {} : { topicId }) }),
      requestId: `moss-news-${req.topic}-${Date.now()}`,
    })
  } catch (error) {
    return failure('dispatch', `派发失败：${errorText(error)}`, sessionId)
  }

  const interval = Math.max(0, options.intervalMs ?? AI_POLL_INTERVAL_MS)
  const maxAttempts = Math.max(1, options.maxAttempts ?? AI_POLL_MAX_ATTEMPTS)
  const sleep = options.sleep ?? delay
  let refreshAvailable = true
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.shouldStop?.() === true) {
      return { status: 'cancelled', code: 'cancelled', message: '已停止等待；任务已在设备上执行，完成后会自动同步。', sessionId }
    }
    await sleep(interval)
    try {
      await host.sync()
    } catch {
      // 同上：单次失败不终止
    }
    let added: number | undefined
    try {
      const refreshed = await host.refreshNews()
      if (refreshed === null) refreshAvailable = false
      else added = refreshed.added
    } catch {
      refreshAvailable = false
    }
    const decision = newsPollDecision(known, host.newsIds(), attempt, maxAttempts)
    if (decision === 'changed') {
      const count = added ?? Math.max(0, host.newsIds().filter((id) => !known.includes(id)).length)
      return {
        status: 'done',
        code: 'ok',
        message: count > 0 ? `检索完成，新增 ${count} 条资讯。` : '检索完成，已出现新资讯。',
        sessionId,
        added: count,
      }
    }
    if (decision === 'timeout') break
  }
  return {
    status: 'timeout',
    code: 'timeout',
    message: refreshAvailable
      ? '已在设备上执行，稍后自动同步；也可以稍后手动点顶栏同步。'
      : '已在设备上执行；当前宿主没有提供新闻读取接口，结果会在下次同步后可见。',
    sessionId,
  }
}

/* ─────────── 真实接线（唯一一处 currentLink / syncNow 的使用） ─────────── */

/**
 * 构造真实的宿主能力。
 *
 * 动态 import：让上面的纯逻辑与测试不依赖 uni/vue；点击时才加载连接层。
 * 约束：这里只调用 `currentLink().call(...)` 与 `syncNow()`，不另开 socket。
 */
export async function liveAiHost(): Promise<AiHost> {
  const [link, engine, appStore, workbench] = await Promise.all([
    import('./link'),
    import('./sync-engine'),
    import('./store'),
    import('./workbench'),
  ])

  const rpc = <T>(method: AiDispatchMethod, params: Record<string, unknown> = {}): Promise<T> => {
    const current = link.currentLink()
    if (current === undefined) return Promise.reject(new Error('尚未连接设备'))
    // 方法名已由 AiDispatchMethod 收敛（与 protocol METHODS 同名），这里只做 gateway 调用
    return current.call<T>(method as never, params)
  }

  /**
   * caps 与 sync-engine 的 workbenchCap 保持同一判定：
   * 有 HostInfo 才取值，优先在线设备，其次当前域，最后第一台；未知按"尝试"。
   */
  const workbenchCap = (): WorkbenchCap => {
    const cards = appStore.state.devices.filter((d) => d.host?.caps !== undefined)
    if (cards.length === 0) return undefined
    const pick = cards.find((d) => d.conn === 'online')
      ?? cards.find((d) => d.deviceId === appStore.state.activeId)
      ?? cards[0]
    return pick?.host?.caps.workbench
  }

  return {
    connected: () => link.currentLink() !== undefined && link.connectionStatus() === 'online',
    localOnly: () => workbench.workDevices.value.find((d) => d.id === workbench.work.deviceId)?.local === true,
    workbenchCap,
    sync: async () => {
      const result = await engine.syncNow()
      return { ok: result.ok, reason: result.reason, error: result.error }
    },
    call: rpc,
    noteUpdatedAt: (noteId) => workbench.ensureDomain().notes.find((n) => n.id === noteId)?.updatedAt,
    newsIds: () => workbench.ensureDomain().news.map((n) => n.id),
    refreshNews: async (): Promise<HostNewsRefresh | null> => {
      let payload: { topics?: readonly HostNewsTopic[]; items?: readonly HostNewsItem[] } | undefined
      try {
        payload = await rpc<{ topics?: readonly HostNewsTopic[]; items?: readonly HostNewsItem[] }>('wb.news.list')
      } catch {
        // 老宿主没有 wb.news.list：如实返回 null，由调用方按超时处理
        return null
      }
      if (!Array.isArray(payload?.items)) return null
      const topics = Array.isArray(payload.topics) ? payload.topics : []
      const cards = normalizeNewsItems(payload.items, topics)
      let added = 0
      workbench.mutate((domain) => {
        const known = new Set(domain.news.map((n) => n.id))
        for (const card of cards) {
          if (known.has(card.id)) continue
          domain.news.unshift(card)
          known.add(card.id)
          added += 1
        }
      })
      return { added, topics }
    },
  }
}
