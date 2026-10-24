/**
 * 个人工作台 · 本地优先数据层（M1）
 *
 * 设计：
 *   - 一台 DSH 设备 = 一个数据域（deviceId 命名空间），任务/日历/专注/笔记/新闻各自独立
 *   - 首版只落本机（uni storage），同步层（wb.* 协议）在 M2 接入，接口已按需预留
 *   - 全部写操作走 mutate：先改内存、立即持久化，UI 乐观更新（M2 再接推送队列）
 */

import { computed, reactive } from 'vue'
import { state as appState } from './store'
import { markDirty } from './sync-queue'

/* ─────────── 类型 ─────────── */

export type Priority = 'high' | 'normal' | 'low'
export type TaskStatus = 'next' | 'doing' | 'waiting'
export type TaskGroup = 'today' | 'scheduled' | 'inbox' | 'done'

export interface SubTask {
  id: string
  title: string
  done: boolean
}

export interface Task {
  id: string
  title: string
  note: string
  status: TaskStatus
  pri: Priority
  /** ISO 日期（yyyy-mm-dd）；空串 = 未排期 */
  date: string
  /** 显示用时间串（如 "9:30" / "今天" / "截止周五"） */
  when: string
  tags: string[]
  sub: SubTask[]
  done: boolean
  /** 归属设备名（跨设备聚合时展示） */
  dev: string
  /** 待同步（M2 用） */
  sync: boolean
  /** 冲突副本（M2 用） */
  conflict: boolean
  /** 绝对起止时间（毫秒）。跨天/跨小时任务用它；缺省时由 date + when 推导 */
  startAt?: number
  endAt?: number
  createdAt: number
  updatedAt: number
}

export interface Reminder {
  id: string
  taskId: string
  /** 触发时间（毫秒） */
  at: number
  label: string
  /** 是否已触发（避免重复提醒） */
  fired: boolean
}

/** 任务状态的中文名与语义色令牌（与主题强调色区分，避免"全是绿色"） */
export const STATUS_META = {
  waiting: { label: '未开始', cssVar: '--st-waiting' },
  next: { label: '进行中', cssVar: '--st-doing' },
  doing: { label: '进行中', cssVar: '--st-doing' },
  done: { label: '已完成', cssVar: '--st-done' },
} as const

export interface Note {
  id: string
  notebook: string
  title: string
  content: string
  tags: string[]
  fav: boolean
  updatedAt: number
  /**
   * 同步冲突标记（P1-3）。
   *
   * 与 Task.conflict 同义：推送时与宿主撞车，本地版本已保留、远端版本另存为
   * 「冲突副本」笔记。带这个标记的行在 pull 时被冻结（不被远端覆盖/删除），
   * 用户手动编辑后自动解除。
   */
  conflict?: boolean
}

export interface FocusSession {
  id: string
  taskId: string
  minutes: number
  completed: boolean
  startedAt: number
}

export interface NewsItem {
  id: string
  topic: string
  title: string
  summary: string
  source: string
  when: string
  url: string
}

export interface Notebook {
  id: string
  name: string
  createdAt: number
}

export interface DomainData {
  tasks: Task[]
  notes: Note[]
  /** 笔记本清单（notes.notebook 存名字，清单是名字的来源） */
  notebooks: Notebook[]
  focus: FocusSession[]
  news: NewsItem[]
  reminders: Reminder[]
}

/* ─────────── 工具 ─────────── */

export const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export function isoDay(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/* ─────────── 设备域 ─────────── */

export interface WorkDevice {
  id: string
  name: string
  sub: string
  online: boolean
  local?: boolean
}

/**
 * 可用的设备域：
 *   - 真实配对过的设备（core/store.devices）优先，`id` 用宿主 hostId
 *   - 再加一个「仅本机」伪域（不同步）
 *   - 没有任何配对设备时退回演示域，保证首屏可用
 */
export const LOCAL_DOMAIN_ID = 'dev-local'

/** 是否处于「本地域」：只有任务/日历/专注/笔记，没有会话、资讯与 AI */
export function isLocalDomain(id = work.deviceId): boolean {
  return id === LOCAL_DOMAIN_ID
}

export const workDevices = computed<WorkDevice[]>(() => {
  const local: WorkDevice = { id: 'dev-local', name: '仅本机', sub: '只存在这台手机', online: true, local: true }
  const real = appState.devices
  // 没有真实配对设备时直接用演示域（DEVICES 里已含「仅本机」）
  if (real.length === 0) return DEVICES
  return [
    ...real.map((d) => ({
      // 数据域跟着宿主走（hostId），不是跟着手机设备走：同一台 PC 换手机仍是同一个域
      id: d.host?.hostId ?? d.deviceId,
      name: d.name || d.host?.name || '未命名设备',
      sub: [d.host?.platform, d.host?.dshVersion].filter((x) => typeof x === 'string' && x.length > 0).join(' · '),
      online: d.conn === 'online' || d.online === true,
    })),
    local,
  ]
})

export const DEVICES: WorkDevice[] = [
  { id: 'dev-a', name: '公司-Mac', sub: 'macOS 15.2 · 10.0.3.27', online: true },
  { id: 'dev-b', name: '家里-PC', sub: 'Windows 11 · 10.0.3.41', online: false },
  { id: 'dev-local', name: '仅本机', sub: '只存在这台手机', online: true, local: true },
]

/* ─────────── 种子（与高保真 demo 对齐） ─────────── */

const today = isoDay()
const T = (n: number): number => Date.now() - n * 86_400_000

function seedTasks(): Task[] {
  const mk = (
    id: string, title: string, opts: Partial<Task> = {},
  ): Task => ({
    id, title, note: '', status: 'next', pri: 'normal', date: today, when: '今天',
    tags: [], sub: [], done: false, dev: '公司-Mac', sync: false, conflict: false,
    createdAt: T(2), updatedAt: T(1), ...opts,
  })
  return [
    mk('t1', '评审支付模块重构方案', { pri: 'high', when: '9:30', status: 'doing', tags: ['重构'], sync: true,
      sub: [{ id: 's1', title: '看旧实现', done: true }, { id: 's2', title: '对齐风控口径', done: false }, { id: 's3', title: '写结论', done: false }] }),
    mk('t2', '周报：同步引擎联调结论', { when: '14:00', tags: ['周报'] }),
    mk('t3', '给妈约周六体检', { when: '17:00', dev: '仅本机' }),
    mk('t4', '补一节同步协议：重试与幂等', { date: '', when: '之后', group: undefined } as Partial<Task>),
    mk('t5', '整理 Q4 竞品动向', { date: '', when: '未排期', conflict: true, dev: '家里-PC', tags: ['竞品'] }),
    mk('t6', '把发票拍给财务', { date: '', when: '未排期', dev: '仅本机' }),
    mk('t7', '合并本周 PR', { done: true, when: '昨天', status: 'next' }),
    mk('t8', '回访问卷初稿', { done: true, when: '昨天', dev: '家里-PC' }),
    mk('t9', '清理下载目录', { done: true, when: '前天', dev: '仅本机' }),
  ]
}

function seedNotes(): Note[] {
  return [
    { id: 'n1', notebook: '工作', title: '同步引擎设计要点', fav: true, tags: ['同步', '架构'], updatedAt: T(0),
      content: '# 同步引擎\n\n- 分域单主：**每个设备域以 PC 为权威**\n- 推送走 `wb.delta.push`，拉取走 `wb.delta.pull`\n- 冲突：LWW + 保留副本，绝不静默丢\n- 删除靠 tombstone 传播（30 天回收站）\n\n> 快照接口只用于首次全量同步与修复。' },
    { id: 'n2', notebook: '工作', title: '支付重构 · 风险清单', tags: ['重构'], fav: false, updatedAt: T(1),
      content: '1. 风控口径不一致\n2. 老接口兼容期\n3. 对账链路回归\n\n处置：先灰度 5%，观察 24h。' },
    { id: 'n3', notebook: '学习', title: 'SQLite WAL 的三个坑', tags: ['sqlite'], fav: false, updatedAt: T(2),
      content: '- 读事务不能跨 checkpoint\n- wal 文件别放网络盘\n- 多进程写要 busy_timeout' },
    { id: 'n4', notebook: '生活', title: '体检前注意事项', tags: ['体检'], fav: false, updatedAt: T(3),
      content: '前一天 22:00 后禁食，早上空腹，带身份证与既往报告。' },
    { id: 'n5', notebook: '生活', title: '周末清单', tags: ['周末'], fav: false, updatedAt: T(4),
      content: '- 换机油\n- 买菜\n- 给相机充电' },
  ]
}

function seedNews(): NewsItem[] {
  return [
    { id: 'w1', topic: 'AI 动态', title: '模型上下文窗口再突破：单次 200 万 token 实测', source: 'The Verge', when: '2 小时前', url: '#',
      summary: '新模型把长上下文与检索结合，官方称在长文档问答上错误率下降 38%，但对推理成本的影响仍待观察。' },
    { id: 'w2', topic: 'AI 动态', title: '端侧推理框架统一 API：一次编译多端运行', source: 'GitHub Blog', when: '5 小时前', url: '#',
      summary: '社区方案把量化、算子融合与内存规划收敛到一套 IR，移动端首帧延迟降低约 45%。' },
    { id: 'w3', topic: '前端', title: 'Chrome 收紧 storage 配额：1MB 上限影响离线应用', source: 'Chromium Blog', when: '昨天', url: '#',
      summary: '文件协议与第三方上下文下的 localStorage 将被限制并可能随时清理，官方建议迁移到 IndexedDB 或原生 SQLite。' },
    { id: 'w4', topic: '前端', title: 'CSS 容器查询进入稳定期：组件级响应式成为默认实践', source: 'web.dev', when: '昨天', url: '#',
      summary: '主流浏览器齐备后，组件可以按容器宽度而非视口自适应，设计系统的断点数量明显减少。' },
    { id: 'w5', topic: '竞品', title: '某待办应用上线「设备域」概念：多端数据互不干扰', source: '少数派', when: '2 天前', url: '#',
      summary: '每个工作设备维护独立数据域，跨设备仅做只读聚合，避免同步冲突——与本产品思路一致。' },
    { id: 'w6', topic: '竞品', title: '笔记工具加入 AI 回写协议：保留元数据的增量更新', source: 'Product Hunt', when: '3 天前', url: '#',
      summary: 'AI 只改正文、不改笔记本与标签，回写后客户端通过增量拉取吸收，减少整篇覆盖带来的丢失。' },
  ]
}

function seedFocus(): FocusSession[] {
  return [
    { id: 'f1', taskId: 't1', minutes: 25, completed: true, startedAt: T(0) - 3_600_000 },
    { id: 'f2', taskId: 't2', minutes: 25, completed: true, startedAt: T(0) - 5_400_000 },
  ]
}

/* ─────────── 存储 ─────────── */

const KEY = (device: string): string => `moss.work.${device}`

function readDomain(device: string): DomainData | undefined {
  try {
    const raw = uni.getStorageSync(KEY(device))
    if (typeof raw === 'string' && raw.length > 0) return JSON.parse(raw) as DomainData
  } catch {
    /* 存储损坏按空域处理，下面会重新播种 */
  }
  return undefined
}

function writeDomain(device: string, data: DomainData): void {
  try {
    uni.setStorageSync(KEY(device), JSON.stringify(data))
  } catch {
    /* 配额/权限问题时静默降级：内存态仍可用 */
  }
}

function seedNotebooks(): Notebook[] {
  return ['工作', '学习', '生活'].map((name, i) => ({ id: `nb-${i + 1}`, name, createdAt: T(5) }))
}

function seed(device: string): DomainData {
  return { tasks: seedTasks(), notes: seedNotes(), notebooks: seedNotebooks(), focus: seedFocus(), news: seedNews(), reminders: [] }
}

/* ─────────── 响应式状态 ─────────── */

export const work = reactive({
  deviceId: 'dev-a',
  /** 全部设备的数据域（按需加载，首个访问时播种） */
  domains: {} as Record<string, DomainData>,
})

const current = computed<DomainData>(() => work.domains[work.deviceId] as DomainData)

export function useWork(): { data: typeof current; deviceId: () => string } {
  return { data: current, deviceId: () => work.deviceId }
}

export function ensureDomain(device = work.deviceId): DomainData {
  const cached = work.domains[device]
  if (cached !== undefined) return cached
  const loaded = readDomain(device) ?? seed(device)
  // 旧版本没有 notebooks 字段：从笔记里补出来，保证升级不丢
  if (!Array.isArray(loaded.notebooks) || loaded.notebooks.length === 0) {
    const names = Array.from(new Set(loaded.notes.map((n) => n.notebook).filter((x) => x.length > 0)))
    loaded.notebooks = (names.length > 0 ? names : ['工作', '学习', '生活']).map((name, i) => ({
      id: `nb-${i + 1}`, name, createdAt: Date.now(),
    }))
  }
  if (!Array.isArray(loaded.reminders)) loaded.reminders = []
  work.domains[device] = loaded
  if (readDomain(device) === undefined) writeDomain(device, loaded)
  return loaded
}

const DEVICE_KEY = 'moss.work.device'

export function switchDevice(device: string): void {
  work.deviceId = device
  ensureDomain(device)
  try {
    uni.setStorageSync(DEVICE_KEY, device)
  } catch {
    /* 存不下就只在本次会话生效 */
  }
}

/** 冷启动恢复上次选择的域（默认演示域） */
function restoreDevice(): void {
  try {
    const saved = uni.getStorageSync(DEVICE_KEY)
    if (typeof saved === 'string' && saved.length > 0) work.deviceId = saved
  } catch {
    /* 读不到用默认 */
  }
}

/** 统一写入口：改内存 → 落盘（M2 在这里接推送队列） */
export function mutate(fn: (d: DomainData) => void): void {
  const d = ensureDomain()
  fn(d)
  writeDomain(work.deviceId, d)
}

/* ─────────── 时间区间与当日聚合 ─────────── */

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 'HH:MM' / '9:30' → 当天毫秒；解析不出返回 undefined */
export function timeOfDay(when: string): { h: number; m: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(when.trim())
  if (m === null) return undefined
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return undefined
  return { h, m: mm }
}

/**
 * 任务的绝对区间。
 * 优先用 startAt/endAt；否则用 date + when 推导（默认 1 小时）。
 */
export function taskSpan(t: Task): { start: number; end: number } | undefined {
  if (typeof t.startAt === 'number' && typeof t.endAt === 'number' && t.endAt > t.startAt) {
    return { start: t.startAt, end: t.endAt }
  }
  if (t.date === '') return undefined
  const hm = timeOfDay(t.when)
  const base = new Date(`${t.date}T00:00:00`).getTime()
  if (Number.isNaN(base)) return undefined
  if (hm === undefined) return { start: base, end: base + 24 * 3600_000 } // 全天
  const start = base + (hm.h * 60 + hm.m) * 60_000
  return { start, end: start + 3600_000 }
}

/** 某一天覆盖到的任务（含跨天任务落在当天的部分） */
export function tasksOnDay(tasks: readonly Task[], iso: string): Task[] {
  const dayStart = new Date(`${iso}T00:00:00`).getTime()
  if (Number.isNaN(dayStart)) return []
  const dayEnd = dayStart + 24 * 3600_000
  return tasks.filter((t) => {
    const span = taskSpan(t)
    if (span === undefined) return t.date === iso
    return span.start < dayEnd && span.end > dayStart
  })
}

/** 新建/改期的统一入口：写绝对区间同时反推 date/when，保证两种视图一致 */
export function scheduleTask(id: string, startAt: number, endAt: number): void {
  const d = new Date(startAt)
  const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const when = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  updateTask(id, { startAt, endAt, date: iso, when })
}

/**
 * 把本地域的数据复制到某个设备域（"上传到设备"）。
 *
 * 语义：只增不覆盖——目标域已有的同 id 条目跳过，避免把电脑上的改动冲掉；
 * 复制后在新域里打脏标记，等 M2 同步推给宿主。
 */
export function uploadLocalTo(targetDevice: string): { tasks: number; notes: number; notebooks: number; focus: number } {
  if (targetDevice === LOCAL_DOMAIN_ID) return { tasks: 0, notes: 0, notebooks: 0, focus: 0 }
  const src = ensureDomain(LOCAL_DOMAIN_ID)
  const dst = ensureDomain(targetDevice)
  let tasks = 0, notes = 0, notebooks = 0, focus = 0

  const taskIds = new Set(dst.tasks.map((t) => t.id))
  for (const t of src.tasks) {
    if (taskIds.has(t.id)) continue
    dst.tasks.push({ ...t, dev: deviceName(targetDevice), updatedAt: Date.now(), sync: true })
    markDirty(targetDevice, 'tasks', t.id, 'upsert')
    tasks += 1
  }

  const noteIds = new Set(dst.notes.map((n) => n.id))
  for (const n of src.notes) {
    if (noteIds.has(n.id)) continue
    dst.notes.push({ ...n, updatedAt: Date.now() })
    markDirty(targetDevice, 'notes', n.id, 'upsert')
    notes += 1
  }

  const nbNames = new Set(dst.notebooks.map((n) => n.name))
  for (const nb of src.notebooks) {
    if (nbNames.has(nb.name)) continue
    const copy = { ...nb, id: uid() }
    dst.notebooks.push(copy)
    markDirty(targetDevice, 'notebooks', copy.id, 'upsert')
    notebooks += 1
  }

  const focusIds = new Set(dst.focus.map((f) => f.id))
  for (const f of src.focus) {
    if (focusIds.has(f.id)) continue
    dst.focus.push({ ...f })
    markDirty(targetDevice, 'focus_sessions', f.id, 'upsert')
    focus += 1
  }

  writeDomain(targetDevice, dst)
  return { tasks, notes, notebooks, focus }
}

/* ─────────── 提醒（本地闹铃） ─────────── */

export function addReminder(taskId: string, at: number, label: string): Reminder {
  const r: Reminder = { id: uid(), taskId, at, label, fired: false }
  mutate((d) => { d.reminders.push(r) })
  return r
}

export function removeReminder(id: string): void {
  mutate((d) => { d.reminders = d.reminders.filter((r) => r.id !== id) })
}

export function markReminderFired(id: string): void {
  mutate((d) => {
    const r = d.reminders.find((x) => x.id === id)
    if (r !== undefined) r.fired = true
  })
}

/** 到点且未触发的提醒（供轮询器使用） */
export function dueReminders(now = Date.now()): Reminder[] {
  return ensureDomain().reminders.filter((r) => !r.fired && r.at <= now)
}

/* ─────────── 派生视图 ─────────── */

export function groupOf(t: Task): TaskGroup {
  if (t.done) return 'done'
  if (t.date === today) return 'today'
  if (t.date !== '') return 'scheduled'
  return 'inbox'
}

export function todayTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => groupOf(t) === 'today')
}

export function domainStats(d: DomainData): { total: number; done: number; pct: number; focusMinutes: number; focusRounds: number } {
  const total = d.tasks.length
  const done = d.tasks.filter((t) => t.done).length
  const focusMinutes = d.focus.reduce((sum, f) => sum + f.minutes, 0)
  return {
    total,
    done,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
    focusMinutes,
    focusRounds: d.focus.filter((f) => f.completed).length,
  }
}

/* ─────────── 动作 ─────────── */

export function addTask(title: string, opts: Partial<Task> = {}): Task {
  const now = Date.now()
  const task: Task = {
    id: uid(), title, note: '', status: 'next', pri: 'normal', date: today, when: '今天',
    tags: [], sub: [], done: false, dev: deviceName(), sync: true, conflict: false,
    createdAt: now, updatedAt: now, ...opts,
  }
  mutate((d) => { d.tasks.unshift(task) })
  markDirty(work.deviceId, 'tasks', task.id, 'upsert')
  return task
}

export function toggleTask(id: string): void {
  mutate((d) => {
    const t = d.tasks.find((x) => x.id === id)
    if (t === undefined) return
    t.done = !t.done
    t.updatedAt = Date.now()
    t.sync = true
    if (t.done) t.sub.forEach((s) => { s.done = true })
  })
  markDirty(work.deviceId, 'tasks', id, 'upsert')
}

export function updateTask(id: string, patch: Partial<Task>): void {
  mutate((d) => {
    const t = d.tasks.find((x) => x.id === id)
    if (t === undefined) return
    // 用户动手编辑 = 认了这一版：解除同步冲突标记（否则该行在 pull 里永久冻结）
    Object.assign(t, patch, { updatedAt: Date.now(), sync: true, conflict: false })
  })
  markDirty(work.deviceId, 'tasks', id, 'upsert')
}

export function toggleSub(taskId: string, subId: string): void {
  mutate((d) => {
    const t = d.tasks.find((x) => x.id === taskId)
    const s = t?.sub.find((x) => x.id === subId)
    if (s === undefined) return
    s.done = !s.done
    t!.updatedAt = Date.now()
  })
  markDirty(work.deviceId, 'tasks', taskId, 'upsert')
}

export function clearDone(): number {
  let n = 0
  const removed: string[] = []
  mutate((d) => {
    const keep = d.tasks.filter((t) => !t.done)
    n = d.tasks.length - keep.length
    removed.push(...d.tasks.filter((t) => t.done).map((t) => t.id))
    d.tasks = keep
  })
  removed.forEach((id) => markDirty(work.deviceId, 'tasks', id, 'delete'))
  return n
}

/**
 * 删除任务（不是"完成"）。
 * 与完成区分：完成会保留在历史里，删除是移除 + 打 tombstone 传播到其它端。
 */
export function removeTask(id: string): void {
  mutate((d) => { d.tasks = d.tasks.filter((t) => t.id !== id) })
  markDirty(work.deviceId, 'tasks', id, 'delete')
}

/** 历史任务：已完成，按完成时间倒序（供「历史」视图与日历回看） */
export function historyTasks(tasks: readonly Task[], limit = 50): Task[] {
  return tasks
    .filter((t) => t.done)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

/* ─────────── 笔记本（对齐 PC 端工作台：建/改名/删/移动笔记） ─────────── */

export function addNotebook(name: string): Notebook | undefined {
  const clean = name.trim()
  if (clean.length === 0) return undefined
  const exists = ensureDomain().notebooks.find((n) => n.name === clean)
  if (exists !== undefined) return exists
  const nb: Notebook = { id: uid(), name: clean, createdAt: Date.now() }
  mutate((d) => { d.notebooks.push(nb) })
  markDirty(work.deviceId, 'notebooks', nb.id, 'upsert')
  return nb
}

/** 改名：笔记本清单 + 该本下所有笔记一起改，避免出现"孤儿笔记" */
export function renameNotebook(from: string, to: string): void {
  const clean = to.trim()
  if (clean.length === 0 || clean === from) return
  mutate((d) => {
    const nb = d.notebooks.find((n) => n.name === from)
    if (nb !== undefined) {
      nb.name = clean
      markDirty(work.deviceId, 'notebooks', nb.id, 'upsert')
    }
    d.notes.forEach((n) => { if (n.notebook === from) n.notebook = clean })
  })
  ensureDomain().notes.filter((n) => n.notebook === clean).forEach((n) => {
    markDirty(work.deviceId, 'notes', n.id, 'upsert')
  })
}

/** 删笔记本：笔记不删，落到「未分类」（PC 端也是保内容优先） */
export function removeNotebook(name: string): void {
  const FALLBACK = '未分类'
  mutate((d) => {
    const nb = d.notebooks.find((n) => n.name === name)
    d.notebooks = d.notebooks.filter((n) => n.name !== name)
    if (nb !== undefined) markDirty(work.deviceId, 'notebooks', nb.id, 'delete')
    d.notes.forEach((n) => { if (n.notebook === name) n.notebook = FALLBACK })
    if (!d.notebooks.some((n) => n.name === FALLBACK)) {
      d.notebooks.push({ id: uid(), name: FALLBACK, createdAt: Date.now() })
    }
  })
  ensureDomain().notes.filter((n) => n.notebook === FALLBACK).forEach((n) => {
    markDirty(work.deviceId, 'notes', n.id, 'upsert')
  })
}

export function moveNote(noteId: string, notebook: string): void {
  updateNote(noteId, { notebook })
}

export function addFocus(taskId: string, minutes: number, completed: boolean): void {
  const id = uid()
  mutate((d) => {
    d.focus.push({ id, taskId, minutes, completed, startedAt: Date.now() })
  })
  markDirty(work.deviceId, 'focus_sessions', id, 'upsert')
}

export function addNote(notebook: string): Note {
  const note: Note = { id: uid(), notebook, title: '未命名笔记', content: '', tags: [], fav: false, updatedAt: Date.now() }
  mutate((d) => { d.notes.unshift(note) })
  markDirty(work.deviceId, 'notes', note.id, 'upsert')
  return note
}

export function updateNote(id: string, patch: Partial<Note>): void {
  mutate((d) => {
    const n = d.notes.find((x) => x.id === id)
    if (n === undefined) return
    // 同 updateTask：手动编辑解除冲突冻结
    Object.assign(n, patch, { updatedAt: Date.now(), conflict: false })
  })
  markDirty(work.deviceId, 'notes', id, 'upsert')
}

export function removeNote(id: string): void {
  mutate((d) => { d.notes = d.notes.filter((n) => n.id !== id) })
  markDirty(work.deviceId, 'notes', id, 'delete')
}

export function deviceName(id = work.deviceId): string {
  return workDevices.value.find((d) => d.id === id)?.name ?? workDevices.value[0]?.name ?? '本机'
}

/** 设备列表变化后校正当前域（配对/解绑都可能让旧 id 失效） */
export function normalizeDevice(): void {
  const list = workDevices.value
  if (!list.some((d) => d.id === work.deviceId)) work.deviceId = list[0]?.id ?? 'dev-local'
  ensureDomain()
}

/* 首屏：恢复上次设备域 + 播种 */
restoreDevice()
ensureDomain()
