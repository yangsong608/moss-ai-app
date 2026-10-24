/**
 * 同步队列（P1-3 第一阶段）：脏标记 + 游标 + 状态
 *
 * 只做"本地事实"，不碰网络：
 *   - 每个设备域记一份 dirty 集合（entity/id）与拉取游标
 *   - 落在 uni storage，冷启动可恢复（离线改了三天再上线也能推）
 *   - SyncEngine（下一阶段）从这里取"待推送清单"、把 pull 到的游标写回这里
 */

import { reactive } from 'vue'

export type SyncEntity = 'tasks' | 'notes' | 'notebooks' | 'news_topics' | 'focus_sessions' | 'spaces'

export interface DirtyItem {
  entity: SyncEntity
  id: string
  op: 'upsert' | 'delete'
  at: number
}

export interface DomainSyncState {
  /** 增量拉取游标（ISO 字符串，服务端返回的 cursor 原样存） */
  cursor: string
  lastSyncAt: number
  dirty: DirtyItem[]
  /** 上次同步的冲突条数（UI 角标用） */
  conflicts: number
}

const KEY = (device: string): string => `moss.sync.${device}`

const EMPTY: DomainSyncState = { cursor: '', lastSyncAt: 0, dirty: [], conflicts: 0 }

export const syncStatus = reactive({
  syncing: false,
  lastError: '' as string,
  /** 当前设备域的待推条数（UI 直接读它） */
  pending: 0,
  conflicts: 0,
})

const cache: Record<string, DomainSyncState> = {}

export function stateOf(device: string): DomainSyncState {
  const hit = cache[device]
  if (hit !== undefined) return hit
  let loaded: DomainSyncState = { ...EMPTY, dirty: [] }
  try {
    const raw = uni.getStorageSync(KEY(device))
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed = JSON.parse(raw) as Partial<DomainSyncState>
      loaded = {
        cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '',
        lastSyncAt: typeof parsed.lastSyncAt === 'number' ? parsed.lastSyncAt : 0,
        dirty: Array.isArray(parsed.dirty) ? (parsed.dirty as DirtyItem[]) : [],
        conflicts: typeof parsed.conflicts === 'number' ? parsed.conflicts : 0,
      }
    }
  } catch {
    /* 损坏的队列按空处理：下一次全量拉取会自愈 */
  }
  cache[device] = loaded
  refreshStatus(device)
  return loaded
}

function persist(device: string): void {
  try {
    uni.setStorageSync(KEY(device), JSON.stringify(stateOf(device)))
  } catch {
    /* 配额满时静默：内存队列仍可推，本轮推送成功后自然清空 */
  }
  refreshStatus(device)
}

function refreshStatus(device: string): void {
  const s = stateOf(device)
  syncStatus.pending = s.dirty.length
  syncStatus.conflicts = s.conflicts
}

/** 标脏：同一 entity/id 只保留一条（op 以最后一次为准） */
export function markDirty(device: string, entity: SyncEntity, id: string, op: 'upsert' | 'delete' = 'upsert'): void {
  const s = stateOf(device)
  const rest = s.dirty.filter((d) => !(d.entity === entity && d.id === id))
  rest.push({ entity, id, op, at: Date.now() })
  s.dirty = rest
  persist(device)
}

/** 推送成功后清掉对应条目 */
export function clearDirty(device: string, done: readonly DirtyItem[]): void {
  const s = stateOf(device)
  const keys = new Set(done.map((d) => `${d.entity}:${d.id}`))
  s.dirty = s.dirty.filter((d) => !keys.has(`${d.entity}:${d.id}`))
  s.lastSyncAt = Date.now()
  persist(device)
}

export function setCursor(device: string, cursor: string): void {
  const s = stateOf(device)
  s.cursor = cursor
  s.lastSyncAt = Date.now()
  persist(device)
}

export function setConflicts(device: string, n: number): void {
  const s = stateOf(device)
  s.conflicts = n
  persist(device)
}

/** 按条数切批：控制帧上限 256KB，保守取 50 条一批 */
export function takeBatch(device: string, limit = 50): DirtyItem[] {
  return stateOf(device).dirty.slice(0, limit)
}

export function pendingCount(device: string): number {
  return stateOf(device).dirty.length
}

export function lastSyncAt(device: string): number {
  return stateOf(device).lastSyncAt
}
