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
  createdAt: number
  updatedAt: number
}

export interface Note {
  id: string
  notebook: string
  title: string
  content: string
  tags: string[]
  fav: boolean
  updatedAt: number
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

export interface DomainData {
  tasks: Task[]
  notes: Note[]
  focus: FocusSession[]
  news: NewsItem[]
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

function seed(device: string): DomainData {
  return { tasks: seedTasks(), notes: seedNotes(), focus: seedFocus(), news: seedNews() }
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
  work.domains[device] = loaded
  if (readDomain(device) === undefined) writeDomain(device, loaded)
  return loaded
}

export function switchDevice(device: string): void {
  work.deviceId = device
  ensureDomain(device)
}

/** 统一写入口：改内存 → 落盘（M2 在这里接推送队列） */
export function mutate(fn: (d: DomainData) => void): void {
  const d = ensureDomain()
  fn(d)
  writeDomain(work.deviceId, d)
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
}

export function updateTask(id: string, patch: Partial<Task>): void {
  mutate((d) => {
    const t = d.tasks.find((x) => x.id === id)
    if (t === undefined) return
    Object.assign(t, patch, { updatedAt: Date.now(), sync: true })
  })
}

export function toggleSub(taskId: string, subId: string): void {
  mutate((d) => {
    const t = d.tasks.find((x) => x.id === taskId)
    const s = t?.sub.find((x) => x.id === subId)
    if (s === undefined) return
    s.done = !s.done
    t!.updatedAt = Date.now()
  })
}

export function clearDone(): number {
  let n = 0
  mutate((d) => {
    const keep = d.tasks.filter((t) => !t.done)
    n = d.tasks.length - keep.length
    d.tasks = keep
  })
  return n
}

export function addFocus(taskId: string, minutes: number, completed: boolean): void {
  mutate((d) => {
    d.focus.push({ id: uid(), taskId, minutes, completed, startedAt: Date.now() })
  })
}

export function addNote(notebook: string): Note {
  const note: Note = { id: uid(), notebook, title: '未命名笔记', content: '', tags: [], fav: false, updatedAt: Date.now() }
  mutate((d) => { d.notes.unshift(note) })
  return note
}

export function updateNote(id: string, patch: Partial<Note>): void {
  mutate((d) => {
    const n = d.notes.find((x) => x.id === id)
    if (n === undefined) return
    Object.assign(n, patch, { updatedAt: Date.now() })
  })
}

export function removeNote(id: string): void {
  mutate((d) => { d.notes = d.notes.filter((n) => n.id !== id) })
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

/* 首屏播种 */
ensureDomain()
