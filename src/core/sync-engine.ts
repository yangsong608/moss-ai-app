/**
 * 同步引擎（P1-3 第二阶段）：push / pull / 冲突处理 / 自动触发
 *
 * 分工：
 *   - `sync-queue.ts` 记本地事实（脏队列、游标、角标）
 *   - `sync-adapt.ts` 只做行映射（纯函数，可单测）
 *   - 本文件做网络与落地：takeBatch → wb.delta.push；wb.delta.pull → LWW apply
 *
 * 三条硬约束（来自 dsh-workbench docs/sync-protocol.md）：
 *   1. `updatedAt` 一律 `YYYY-MM-DD HH:MM:SS`（本地时间、字典序可比），
 *      绝不能写 ISO 的 `T`/`Z`——宿主游标与 LWW 都按字符串比较。
 *   2. 游标是不透明值，只原样回传；每次 since 回退 5 分钟重叠加拉。
 *   3. 冲突绝不静默丢数据：本地保留并标 `conflict=true`，远端版本落成
 *      「冲突副本：<标题>」笔记。
 *
 * 顺序是 push → pull：先把本地未推的改动送到宿主，避免"刚拉的远端行
 * 覆盖了本地还没推的编辑"。同步错误只写 `syncStatus.lastError`，不抛给 UI。
 */

import type { WbChange, WbDelta, WbPushConflict, WbPushResult } from '@dsh-link/protocol'
import { adapt, entityOf, type LocalEntity } from './sync-adapt'
import { state } from './store'
import { currentLink } from './link'
import {
  clearDirty,
  markDirty,
  setConflicts,
  setCursor,
  stateOf,
  syncStatus,
  takeBatch,
  type DirtyItem,
} from './sync-queue'
import {
  deviceName,
  ensureDomain,
  mutate,
  uid,
  work,
  workDevices,
  type DomainData,
  type FocusSession,
  type Note,
  type Task,
} from './workbench'

/**
 * 映射层从引擎也导出一份：业务/测试只认 `@/core/sync-engine` 一个入口，
 * 实现仍在 `sync-adapt.ts`（纯函数、无 uni 依赖，可被 node 直接测）。
 */
export { adapt, entityOf } from './sync-adapt'
export type { LocalEntity } from './sync-adapt'

/* ─────────── 常量 ─────────── */

/** 自动同步间隔：前台 30s 一次（docs/sync-protocol.md §6 推荐） */
export const SYNC_INTERVAL_MS = 30_000
/** 单批推送上限：控制帧体积（协议帧上限 256KB） */
const PUSH_BATCH = 50
/** 单批拉取上限：宿主默认也是 200 */
const PULL_LIMIT = 200
/** 防止 more 永远为 true 时把页面拖死 */
const MAX_PULL_BATCHES = 50
/** 游标重叠加拉窗口（分钟） */
const OVERLAP_MINUTES = 5

/** 冲突副本存放的笔记本名 */
const CONFLICT_NOTEBOOK = '冲突'

/* ─────────── 对外类型 ─────────── */

export type SyncReason = 'offline' | 'error' | 'busy'

export interface SyncResult {
  ok: boolean
  reason?: SyncReason
  error?: string
  /** 本次被宿主接受的条数 */
  pushed?: number
  /** 本次落地到本地的远端变更条数 */
  applied?: number
  /** 当前仍标着 conflict 的本地行数 */
  conflicts?: number
}

export interface PushOutcome {
  ok: boolean
  pushed: number
  conflicts: number
  error?: string
}

export interface PullOutcome {
  ok: boolean
  applied: number
  cursor: string
  error?: string
}

/* ─────────── 小工具 ─────────── */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function keyOf(entity: string, id: string): string {
  return `${entity}:${id}`
}

/**
 * 宿主能力：`workbench` 为 0 说明没装 dsh-workbench，别把它当网络故障。
 *
 * caps 只有在配对时拿到过 HostInfo 才存在；完全没有 HostInfo（老数据/演示域）
 * 时返回 undefined，按"未知即尝试"处理——真不支持会在 RPC 层报错并落到
 * `syncStatus.lastError`，比在这里瞎猜更诚实。
 */
function workbenchCap(): 0 | 1 | undefined {
  const cards = state.devices.filter((d) => d.host?.caps !== undefined)
  if (cards.length === 0) return undefined
  const pick = cards.find((d) => d.conn === 'online')
    ?? cards.find((d) => d.deviceId === state.activeId)
    ?? cards[0]
  return pick?.host?.caps.workbench
}

/* ─────────── 本地行查找 ─────────── */

type LocalRow = Task | Note | FocusSession

function findLocal(data: DomainData, entity: LocalEntity, id: string): LocalRow | undefined {
  switch (entity) {
    case 'tasks':
      return data.tasks.find((t) => t.id === id)
    case 'notes':
      return data.notes.find((n) => n.id === id)
    case 'focus_sessions':
      return data.focus.find((f) => f.id === id)
  }
}

function titleOf(row: LocalRow | undefined): string {
  if (row === undefined) return ''
  if ('title' in row) return row.title
  return row.taskId
}

/** 本地时间（epoch → 宿主时间串）：任务/笔记看 updatedAt，专注看 startedAt */
function localUpdatedAt(row: LocalRow): string {
  if ('startedAt' in row) return adapt.ts.format(row.startedAt)
  return adapt.ts.format(row.updatedAt)
}

function flagConflict(row: LocalRow | undefined): void {
  if (row !== undefined && 'conflict' in row) row.conflict = true
}

/** 域里仍标着 conflict 的行数（任务 + 笔记；专注没有 conflict 字段） */
export function conflictCount(device = work.deviceId): number {
  const data = ensureDomain(device)
  return data.tasks.filter((t) => t.conflict).length + data.notes.filter((n) => n.conflict === true).length
}

/* ─────────── 脏项 → WbChange ─────────── */

/**
 * 一条脏项 → 一条协议变更。
 *
 * - `delete` 只发 `{entity,id,op,updatedAt}`（宿主删行并写墓碑）；
 * - `upsert` 用**本地行的 editedAt** 做 updatedAt（LWW 依据），行内容走映射；
 * - 本地行已经不存在（建了又删）时返回 delete，避免把空 upsert 推成脏数据。
 */
function changeOf(device: string, item: DirtyItem): WbChange | undefined {
  const entity = entityOf(item.entity)
  if (entity === undefined) return undefined
  const data = ensureDomain(device)
  const row = findLocal(data, entity, item.id)
  if (item.op === 'delete') {
    return { entity, id: item.id, op: 'delete', updatedAt: adapt.ts.format(item.at) }
  }
  if (row === undefined) {
    return { entity, id: item.id, op: 'delete', updatedAt: adapt.ts.format(item.at) }
  }
  return { entity, id: item.id, op: 'upsert', updatedAt: localUpdatedAt(row), row: rowOf(entity, row) }
}

function rowOf(entity: LocalEntity, row: LocalRow): Record<string, unknown> {
  switch (entity) {
    case 'tasks':
      return adapt.task.toRow(row as Task)
    case 'notes':
      return adapt.note.toRow(row as Note)
    case 'focus_sessions':
      return adapt.focus.toRow(row as FocusSession)
  }
}

/* ─────────── push ─────────── */

/**
 * 推送一批本地脏项。
 *
 * 清理时机：宿主 accepted，或明确返回了 conflict——两者都算"这条已经处理过"。
 * 冲突条目不清理的话，下一轮会推进同样的数据、再冲突一次、再生成一份冲突副本，
 * 队列和笔记都会无限膨胀；冲突本身由 handleConflicts 落地（本地保留 + 副本）。
 */
export async function push(device = work.deviceId): Promise<PushOutcome> {
  const link = currentLink()
  if (link === undefined) return { ok: false, pushed: 0, conflicts: 0, error: '尚未连接主机' }

  const batch = takeBatch(device, PUSH_BATCH)
  if (batch.length === 0) return { ok: true, pushed: 0, conflicts: 0 }

  const changes: WbChange[] = []
  const sent: DirtyItem[] = []
  const dropped: DirtyItem[] = []
  for (const item of batch) {
    const change = changeOf(device, item)
    if (change === undefined) {
      // 本地没有该实体的模型（notebooks/news_topics/…）：推不了，占着队头只会饿死后面的脏项
      dropped.push(item)
      continue
    }
    changes.push(change)
    sent.push(item)
  }
  // 本地没有可映射模型的实体：清掉脏标记，避免永久占住批次头部
  if (dropped.length > 0) clearDirty(device, dropped)
  if (changes.length === 0) return { ok: true, pushed: 0, conflicts: 0 }

  let result: WbPushResult
  try {
    result = await link.call<WbPushResult>('wb.delta.push', { changes })
  } catch (error) {
    return { ok: false, pushed: 0, conflicts: 0, error: errorText(error) }
  }

  const accepted = new Set(Array.isArray(result?.accepted) ? result.accepted : [])
  const conflicts = Array.isArray(result?.conflicts) ? result.conflicts : []
  const conflictKeys = new Set(conflicts.map((c) => keyOf(c.entity, c.id)))
  const done = sent.filter((item) => conflictKeys.has(keyOf(item.entity, item.id)) || accepted.has(item.id))
  if (done.length > 0) clearDirty(device, done)
  if (conflicts.length > 0) handleConflicts(device, conflicts)
  return { ok: true, pushed: accepted.size, conflicts: conflicts.length }
}

/* ─────────── 冲突处理 ─────────── */

/**
 * 冲突处理（绝不静默丢数据）：
 *   - `current === null`：远端已删。本地行**保留**并标 conflict，等用户决定；
 *   - 否则：远端 current 落成「冲突副本：<标题>」笔记（放进「冲突」笔记本），
 *     本地版本标 conflict。副本会进推送队列，另一台设备也能看到。
 * 标了 conflict 的本地行在 pull 时冻结（不再被远端覆盖/删除），
 * 否则推送刚判的冲突会被紧随其后的 pull 立刻抹平。
 */
function handleConflicts(device: string, conflicts: readonly WbPushConflict[]): void {
  if (work.deviceId !== device) return
  const copies: Note[] = []
  mutate((data) => {
    for (const conflict of conflicts) {
      const entity = entityOf(conflict.entity)
      if (entity === undefined) continue
      const local = findLocal(data, entity, conflict.id)
      flagConflict(local)
      if (conflict.current === null) continue
      const copy = buildConflictNote(conflict, titleOf(local))
      copies.push(copy)
      data.notes.unshift(copy)
    }
  })
  // 副本要同步出去：只在本机保留等于"半个数据没丢"
  for (const note of copies) markDirty(device, 'notes', note.id, 'upsert')
  setConflicts(device, conflictCount(device))
}

function buildConflictNote(conflict: WbPushConflict, localTitle: string): Note {
  const current = conflict.current ?? {}
  const remoteTitle = typeof current.title === 'string' ? current.title : ''
  const title = adapt.conflictTitle(localTitle || remoteTitle || conflict.id)
  const body = typeof current.content === 'string' ? current.content : ''
  const lines = [
    `- 实体：${conflict.entity}`,
    `- ID：${conflict.id}`,
    `- 远端更新：${typeof current.updatedAt === 'string' ? current.updatedAt : '未知'}`,
    '',
    '远端版本字段：',
    ...Object.keys(current).sort().map((field) => `- ${field}: ${renderValue(current[field])}`),
  ]
  if (body !== '') {
    lines.push('', '远端版本正文：', '', body)
  }
  return {
    id: uid(),
    notebook: CONFLICT_NOTEBOOK,
    title,
    content: lines.join('\n'),
    tags: ['同步冲突'],
    fav: false,
    conflict: false,
    updatedAt: Date.now(),
  }
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}…` : value
  if (value === null || value === undefined) return '—'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/* ─────────── pull ─────────── */

/**
 * 拉取增量直到 `more=false`，逐条 LWW apply，最后写回游标。
 *
 * since 先回退 5 分钟（重叠加拉），后续批次用服务端返回的游标原样推进；
 * `more` 只表示本批被 limit 截断，不是"还有队列"。
 */
export async function pull(device = work.deviceId): Promise<PullOutcome> {
  const link = currentLink()
  const startCursor = stateOf(device).cursor
  if (link === undefined) return { ok: false, applied: 0, cursor: startCursor, error: '尚未连接主机' }

  let since = adapt.ts.overlap(startCursor, OVERLAP_MINUTES)
  let cursor = startCursor
  let applied = 0
  try {
    for (let round = 0; round < MAX_PULL_BATCHES; round += 1) {
      const params: Record<string, unknown> = { limit: PULL_LIMIT }
      if (since !== '') params.since = since
      const delta = await link.call<WbDelta>('wb.delta.pull', params)
      const changes: WbChange[] = Array.isArray(delta?.changes) ? [...delta.changes] : []
      // 中途切了设备域：这一批属于旧域，落地会写错文件，直接停
      if (work.deviceId !== device) break
      if (changes.length > 0) applied += applyChanges(device, changes)
      const next = typeof delta?.cursor === 'string' && delta.cursor !== '' ? delta.cursor : cursor
      cursor = next
      // more 只表示本批被 limit 截断；没有变更却还给 more 时不能原地循环
      if (delta?.more !== true || changes.length === 0) break
      since = next
    }
  } catch (error) {
    return { ok: false, applied, cursor, error: errorText(error) }
  }
  setCursor(device, cursor)
  setConflicts(device, conflictCount(device))
  return { ok: true, applied, cursor }
}

/**
 * 落地一批远端变更（一次 mutate = 一次落盘）。
 * 返回真正改动了本地的条数（LWW 判负的、实体不认的都不算）。
 */
function applyChanges(device: string, changes: readonly WbChange[]): number {
  if (work.deviceId !== device) return 0
  let applied = 0
  const drop: DirtyItem[] = []
  const dirtyByKey = new Map(stateOf(device).dirty.map((item) => [keyOf(item.entity, item.id), item]))
  mutate((data) => {
    for (const change of changes) {
      const entity = entityOf(change.entity)
      if (entity === undefined) continue
      if (change.op === 'delete') {
        if (removeLocal(data, entity, change.id)) applied += 1
        // 远端已删：本地那条脏标记没有意义了，不清的话会一直重推
        const dirty = dirtyByKey.get(keyOf(entity, change.id))
        if (dirty !== undefined) drop.push(dirty)
        continue
      }
      if (upsertLocal(device, data, entity, change)) applied += 1
    }
  })
  if (drop.length > 0) clearDirty(device, drop)
  return applied
}

function removeLocal(data: DomainData, entity: LocalEntity, id: string): boolean {
  switch (entity) {
    case 'tasks': {
      const local = data.tasks.find((t) => t.id === id)
      if (local === undefined) return false
      if (local.conflict) return false // 冲突行冻结：远端删除不代表用户的选择
      data.tasks = data.tasks.filter((t) => t.id !== id)
      return true
    }
    case 'notes': {
      const local = data.notes.find((n) => n.id === id)
      if (local === undefined) return false
      if (local.conflict === true) return false
      data.notes = data.notes.filter((n) => n.id !== id)
      return true
    }
    case 'focus_sessions': {
      const before = data.focus.length
      data.focus = data.focus.filter((f) => f.id !== id)
      return data.focus.length !== before
    }
  }
}

function upsertLocal(device: string, data: DomainData, entity: LocalEntity, change: WbChange): boolean {
  const row = (change.row ?? {}) as Record<string, unknown>
  const remoteAt = adapt.ts.parse(change.updatedAt)
  switch (entity) {
    case 'tasks': {
      const local = data.tasks.find((t) => t.id === change.id)
      if (local === undefined) {
        data.tasks.unshift(adapt.task.fromRow(row, change.id, {
          updatedAt: remoteAt > 0 ? remoteAt : Date.now(),
          dev: deviceName(device),
        }))
        return true
      }
      if (local.conflict) return false
      if (remoteAt <= local.updatedAt) return false
      Object.assign(local, adapt.task.fromRow(row, change.id, { prev: local, updatedAt: remoteAt, dev: local.dev }))
      return true
    }
    case 'notes': {
      const local = data.notes.find((n) => n.id === change.id)
      if (local === undefined) {
        data.notes.unshift(adapt.note.fromRow(row, change.id, { updatedAt: remoteAt > 0 ? remoteAt : Date.now() }))
        return true
      }
      if (local.conflict === true) return false
      if (remoteAt <= local.updatedAt) return false
      Object.assign(local, adapt.note.fromRow(row, change.id, { prev: local, updatedAt: remoteAt }))
      return true
    }
    case 'focus_sessions': {
      const local = data.focus.find((f) => f.id === change.id)
      if (local === undefined) {
        data.focus.push(adapt.focus.fromRow(row, change.id, { updatedAt: remoteAt > 0 ? remoteAt : Date.now() }))
        return true
      }
      // focus_sessions 的时间列就是 startedAt，没有独立的 updatedAt
      if (remoteAt <= local.startedAt) return false
      Object.assign(local, adapt.focus.fromRow(row, change.id, { prev: local, updatedAt: remoteAt }))
      return true
    }
  }
}

/* ─────────── syncNow ─────────── */

/**
 * 一次完整同步：push → pull。
 *
 * 没有连接或宿主 caps 不含 workbench 时返回 `{ok:false, reason:'offline'}`；
 * 其余错误只写 `syncStatus.lastError`（不抛给 UI，UI 只读响应式状态）。
 */
export async function syncNow(): Promise<SyncResult> {
  if (syncStatus.syncing) return { ok: false, reason: 'busy' }
  const device = work.deviceId
  // 「仅本机」伪域（dev-local）按定义不过网：推上去会把"只存在这台手机"变成共享数据
  if (workDevices.value.find((d) => d.id === device)?.local === true) return { ok: false, reason: 'offline' }
  const link = currentLink()
  if (link === undefined) return { ok: false, reason: 'offline' }
  if (workbenchCap() === 0) return { ok: false, reason: 'offline' }

  syncStatus.syncing = true
  syncStatus.lastError = ''
  try {
    const pushed = await push(device)
    if (!pushed.ok) throw new Error(pushed.error ?? '推送失败')
    const pulled = await pull(device)
    if (!pulled.ok) throw new Error(pulled.error ?? '拉取失败')
    return {
      ok: true,
      pushed: pushed.pushed,
      applied: pulled.applied,
      conflicts: conflictCount(device),
    }
  } catch (error) {
    const text = errorText(error)
    syncStatus.lastError = text
    return { ok: false, reason: 'error', error: text }
  } finally {
    syncStatus.syncing = false
    // 让顶栏角标立刻反映最新队列（stateOf 会 refreshStatus）
    stateOf(work.deviceId)
  }
}

/* ─────────── 自动触发 ─────────── */

let timer: ReturnType<typeof setInterval> | undefined
let networkBound = false
let appShowBound = false

/** 网络恢复时触发一次（离线改了几天，一联网就收敛） */
function bindNetwork(): void {
  if (networkBound) return
  try {
    uni.onNetworkStatusChange((res) => {
      if (res.isConnected) void syncNow()
    })
    networkBound = true
  } catch {
    /* 部分端不支持网络状态事件：只靠定时 */
  }
}

/** 回到前台时触发一次（onAppShow 在 App 端可用，H5 没有就跳过） */
function bindAppShow(): void {
  if (appShowBound) return
  const hook = (uni as unknown as { onAppShow?: (cb: () => void) => void }).onAppShow
  if (typeof hook !== 'function') return
  try {
    hook(() => { void syncNow() })
    appShowBound = true
  } catch {
    /* 平台不支持：忽略 */
  }
}

/**
 * 启动自动同步（幂等）：
 *   - 30s 定时一轮（上一轮没结束就跳过，`syncStatus.syncing` 挡住重入）；
 *   - 网络恢复 / 回到前台各触发一次；
 *   - 每次调用本身也触发一次——WorkShell 的 onMounted 即"页面 onShow"，切 Tab 会重挂载。
 */
export function startAutoSync(intervalMs = SYNC_INTERVAL_MS): void {
  if (timer === undefined) {
    timer = setInterval(() => { void syncNow() }, Math.max(5_000, intervalMs))
  }
  bindNetwork()
  bindAppShow()
  void syncNow()
}

/** 停掉定时器（测试/热重载用；不影响已发出的请求） */
export function stopAutoSync(): void {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}
