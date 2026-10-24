/**
 * 同步行映射（P1-3 · 纯函数层，无 uni / vue 依赖）
 *
 * 为什么单独一层：
 *   - 映射是同步里最容易漂的代码（字段改名、宿主加列），必须能单独测；
 *   - `sync-engine.ts` 依赖 uni storage / 连接层，node 里 import 会直接炸，
 *     所以把纯映射拆出来，`scripts/sync-adapter-test.mjs` 编译这一个文件就能测；
 *   - `sync-engine.ts` 重新导出 `adapt`，业务代码只认一个入口。
 *
 * 约定（对齐 dsh-workbench docs/sync-protocol.md §4）：
 *   - 时间戳是**本地时间、无时区、可字典序比较**的 `YYYY-MM-DD HH:MM:SS`；
 *     绝不写 ISO 的 `T`/`Z`（会改变字典序，游标与 LWW 全部失真）。
 *   - delta 里的 row 是宿主完整行（camelCase），但同步只认映射表里的字段；
 *     缺失字段沿用本地旧值，不用"缺失"去清空本地（§6 约束）。
 */

import type { FocusSession, Note, Priority, Task, TaskStatus } from './workbench'

/** 本地有模型、参与增量同步的实体（与 sync-queue 的 SyncEntity 子集一致） */
export type LocalEntity = 'tasks' | 'notes' | 'focus_sessions'

const TASK_STATUSES: readonly TaskStatus[] = ['next', 'doing', 'waiting']
const PRIORITIES: readonly Priority[] = ['high', 'normal', 'low']

/* ─────────── 基础读值（宿主行字段可能缺失 / 类型不对） ─────────── */

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/* ─────────── 时间戳 ─────────── */

/**
 * epoch 毫秒 → `YYYY-MM-DD HH:MM:SS`（**本地时间**）。
 *
 * 不能用 toISOString()：宿主按字符串字典序比较，`2026-10-24T12:00:00.000Z`
 * 与 `2026-10-24 20:00:00` 混在一起排出来的顺序是错的。
 */
export function formatTs(ms: number): string {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now())
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/**
 * 宿主时间串 → epoch 毫秒（按**本地时间**解析）。
 *
 * 不用 `new Date(str)`：`YYYY-MM-DD HH:MM:SS` 在部分 WebView/JS 引擎里被判成 UTC，
 * 时区偏移会让 LWW 差出 8 小时——那等于远端永远"更新"。
 * 兼容 `YYYY-MM-DD`、`YYYY-MM-DD HH:MM`、ISO 的 `T` 形式。
 */
export function parseTs(value: unknown): number {
  if (typeof value !== 'string') return 0
  const text = value.trim()
  if (text === '') return 0
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text)
  if (m !== null) {
    const [, y, mo, d, h, mi, s] = m
    const ms = new Date(
      Number(y), Number(mo) - 1, Number(d),
      Number(h ?? '0'), Number(mi ?? '0'), Number(s ?? '0'),
    ).getTime()
    return Number.isFinite(ms) ? ms : 0
  }
  const fallback = Date.parse(text)
  return Number.isFinite(fallback) ? fallback : 0
}

/**
 * 拉取游标回退 N 分钟（重叠加拉，docs/sync-protocol.md §3）。
 *
 * delta 是"时间列 > since"的顺序扫描，同一秒内后写入的行可能被下一批跳过；
 * 回退 5 分钟再拉、靠 id 幂等 upsert 收敛。空游标（首次同步）保持空。
 */
export function overlapCursor(cursor: string, minutes = 5): string {
  const text = typeof cursor === 'string' ? cursor.trim() : ''
  // 空串与 '0' 都表示"首次/全量"（协议里 since=0 等价于省略）
  if (text === '' || text === '0') return ''
  const base = parseTs(text)
  if (base === 0) return ''
  return formatTs(base - Math.max(0, minutes) * 60_000)
}

/* ─────────── when ↔ start ─────────── */

/**
 * 本地 `when` → 宿主 `start`。
 *
 * 宿主任务表没有 `when` 列（只有 date/start/end），所以只把"看起来像时刻"的
 * when（9:30 / 14:00）写成 start，其余（今天、未排期、截止周五）留空。
 */
export function whenToStart(when: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(when.trim())
  if (m === null) return ''
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return ''
  return `${pad2(hour)}:${pad2(minute)}`
}

/** 宿主 `start` → 本地 `when`；没有时刻就是「未排期」（宿主无 when）。 */
export function startToWhen(start: string): string {
  const m = /(\d{1,2}):(\d{2})/.exec(start.trim())
  if (m === null) return '未排期'
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return '未排期'
  return `${pad2(hour)}:${pad2(minute)}`
}

/* ─────────── 冲突副本标题 ─────────── */

/** `冲突副本：<标题>`；空标题回退「未命名」。 */
export function conflictTitle(title: string): string {
  const text = typeof title === 'string' ? title.trim() : ''
  return `冲突副本：${text === '' ? '未命名' : text}`
}

/* ─────────── 任务 ─────────── */

export interface TaskAdaptOptions {
  /** 本地旧行：宿主行没带的字段沿用它（不用缺失清空本地） */
  prev?: Task
  /** 这条变更的 updatedAt（epoch 毫秒）；缺省用 row.updatedAt / 现在 */
  updatedAt?: number
  /** 新插入的行落在哪个设备域（Task.dev 展示用） */
  dev?: string
}

/** 本地 Task → 宿主 tasks 行（只发映射表字段，宿主按 `{...当前行, ...row}` 合并） */
export function taskToRow(task: Task): Record<string, unknown> {
  return {
    title: task.title,
    status: task.status,
    priority: task.pri,
    date: task.date,
    start: whenToStart(task.when),
    end: '',
  }
}

/** 宿主 tasks 行 → 本地 Task（`when` 由 start 生成） */
export function taskFromRow(row: Record<string, unknown>, id: string, options: TaskAdaptOptions = {}): Task {
  const prev = options.prev
  const start = readString(row.start)
  const tags = readStringArray(row.tags)
  return {
    id,
    title: readString(row.title, prev?.title ?? '未命名任务'),
    note: prev?.note ?? '',
    status: TASK_STATUSES.includes(row.status as TaskStatus) ? (row.status as TaskStatus) : prev?.status ?? 'next',
    pri: PRIORITIES.includes(row.priority as Priority) ? (row.priority as Priority) : prev?.pri ?? 'normal',
    date: readString(row.date, prev?.date ?? ''),
    when: startToWhen(start),
    tags: tags ?? prev?.tags ?? [],
    sub: prev?.sub ?? [],
    done: prev?.done ?? false,
    dev: options.dev ?? prev?.dev ?? '',
    sync: prev?.sync ?? true,
    conflict: prev?.conflict ?? false,
    createdAt: prev?.createdAt ?? (parseTs(row.createdAt) || options.updatedAt || Date.now()),
    updatedAt: options.updatedAt ?? prev?.updatedAt ?? Date.now(),
  }
}

/* ─────────── 笔记 ─────────── */

export interface NoteAdaptOptions {
  prev?: Note
  updatedAt?: number
}

/**
 * 本地 Note → 宿主 notes 行。
 *
 * 宿主只有 `notebookId`，没有笔记本名；本地 `notebook` 又存的是展示名。
 * 协议 §6 允许"直接存 notebookId"：这里把本地 notebook 原样塞进 notebookId，
 * 拉回时优先 notebook 名、其次 notebookId——两种来源都不会丢。
 */
export function noteToRow(note: Note): Record<string, unknown> {
  return {
    notebookId: note.notebook,
    title: note.title,
    content: note.content,
    tags: note.tags,
    pinned: note.fav,
  }
}

/** 宿主 notes 行 → 本地 Note（pinned ↔ fav，notebookId/notebook → notebook） */
export function noteFromRow(row: Record<string, unknown>, id: string, options: NoteAdaptOptions = {}): Note {
  const prev = options.prev
  const tags = readStringArray(row.tags)
  const pinned = typeof row.pinned === 'boolean' ? row.pinned : prev?.fav ?? false
  return {
    id,
    notebook: readString(row.notebook) || readString(row.notebookId) || prev?.notebook || '默认',
    title: readString(row.title, prev?.title ?? '未命名笔记'),
    content: typeof row.content === 'string' ? row.content : prev?.content ?? '',
    tags: tags ?? prev?.tags ?? [],
    fav: pinned,
    conflict: prev?.conflict ?? false,
    updatedAt: options.updatedAt ?? prev?.updatedAt ?? Date.now(),
  }
}

/* ─────────── 专注 ─────────── */

export interface FocusAdaptOptions {
  prev?: FocusSession
  updatedAt?: number
}

/** 本地 FocusSession → 宿主 focus_sessions 行（startedAt 落成时间串） */
export function focusToRow(session: FocusSession): Record<string, unknown> {
  return {
    taskId: session.taskId,
    startedAt: formatTs(session.startedAt),
    minutes: session.minutes,
    completed: session.completed,
  }
}

/** 宿主 focus_sessions 行 → 本地 FocusSession（时间串解析回 epoch） */
export function focusFromRow(row: Record<string, unknown>, id: string, options: FocusAdaptOptions = {}): FocusSession {
  const prev = options.prev
  const startedAt = parseTs(row.startedAt)
  const minutes = Number(row.minutes)
  const completed = typeof row.completed === 'boolean'
    ? row.completed
    : row.completed === 1 || row.completed === '1'
      ? true
      : prev?.completed ?? false
  return {
    id,
    taskId: readString(row.taskId, prev?.taskId ?? ''),
    minutes: Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : prev?.minutes ?? 0,
    completed,
    startedAt: startedAt > 0 ? startedAt : prev?.startedAt ?? options.updatedAt ?? Date.now(),
  }
}

/* ─────────── 实体名 ─────────── */

/** 宿主实体名 → 本地实体（`focus` 是 `focus_sessions` 的兼容别名） */
export function entityOf(entity: string): LocalEntity | undefined {
  switch (entity) {
    case 'tasks':
      return 'tasks'
    case 'notes':
      return 'notes'
    case 'focus_sessions':
    case 'focus':
      return 'focus_sessions'
    default:
      return undefined
  }
}

/* ─────────── adapt：唯一入口 ─────────── */

/**
 * 映射集中入口。`sync-engine.ts` 从这里取，测试也测这里——
 * 两份实现是漂移的根源，所以只留一份。
 */
export const adapt = {
  task: { entity: 'tasks' as const, toRow: taskToRow, fromRow: taskFromRow },
  note: { entity: 'notes' as const, toRow: noteToRow, fromRow: noteFromRow },
  focus: { entity: 'focus_sessions' as const, toRow: focusToRow, fromRow: focusFromRow },
  ts: { format: formatTs, parse: parseTs, overlap: overlapCursor },
  when: { toStart: whenToStart, fromStart: startToWhen },
  conflictTitle,
  entityOf,
} as const
