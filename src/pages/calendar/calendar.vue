<script setup lang="ts">
/**
 * 日历（周 / 月）。
 *
 * 周视图是主视图：7 天 × 8:00–21:00 网格，任务按**绝对区间**（startAt/endAt）落成色块；
 * 没有绝对区间的旧数据由 `taskSpan` 从 `date + when` 推导。跨天任务按天切成片段，
 * 每天都能看到自己那一段（片段上的「跨天 / 次日」就是跨天区间标记）。
 * 月视图用来"找密度"——点某天直接跳回那一周。下方永远跟着选中日期的安排列表，
 * 与「今天」页同源（都走 `tasksOnDay`），加一条也在这里。
 *
 * 数据只读 @/core/workbench 的 DomainData；改期 / 改状态在共用详情抽屉里完成。
 *
 * 手势（P0-4）：
 *   1. 长按任务条 → 弹出操作菜单（移动 / 改期 · 编辑 · 设置/取消提醒 · 时长 · 删除）。
 *      菜单用共用 MossSheet（页内自绘），不用 uni.showActionSheet：
 *      原生弹层与应用视觉两张皮，且部分平台最多只显示 6 项。
 *   2. 选「移动 / 改期」进入移动模式：
 *      - 拖动：按住色块随手指走，一个 fixed 幽灵条跟手，落点按列宽 / 行高算（15 分钟对齐），
 *        松手走 `scheduleTask(id, 落点, 落点 + 原时长)`——**时长保持不变**。
 *      - 兜底：点日期格 / 日头只换那一天，原时刻与时长原样带走。
 *   3. 删除：二次确认后 `removeTask`，网格与安排列表即时消失。
 *   4. 提醒：长按菜单「设置提醒」选提前量（准时 / 5 / 15 / 30 分钟）→ `addReminder`，
 *      页面每 15 秒轮询 `dueReminders()`：App 端走 plus.push 本地通知，H5 已授权走
 *      Web Notification，都没有就 showModal + 振动。触发后 `markReminderFired` 防重复。
 *      首次进入**不**申请通知权限，只有用户第一次设提醒时才请求。
 *   5. 新建：工具条「＋ 新建」打开页内表单，开始 / 结束各有日期 + 时间（结束可跨天、
 *      默认 = 开始 + 1 小时），保存先 `addTask` 再 `scheduleTask`。
 *
 * 坐标只用来"猜落点"：列宽从 createSelectorQuery 量（滚动不影响宽度），
 * 高度用与 CSS 严格一致的 HOUR_H 等分；两者都失败时退回点格子，不会写错日期。
 */
import { computed, getCurrentInstance, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import WorkShell from '@/components/WorkShell.vue'
import WorkTaskDetail from '@/components/WorkTaskDetail.vue'
import MossSheet, { type SheetItem } from '@/components/MossSheet.vue'
import {
  STATUS_META,
  WEEKDAYS,
  addReminder,
  addTask,
  dueReminders,
  isoDay,
  markReminderFired,
  removeReminder,
  removeTask,
  scheduleTask,
  taskSpan,
  tasksOnDay,
  timeOfDay,
  updateTask,
  useWork,
  work,
  type Reminder,
  type Task,
} from '@/core/workbench'
import { haptic } from '@/core/haptic'

const { data } = useWork()

/**
 * 页面实例要在这里先抓住：getCurrentInstance() 只在 setup / 生命周期里有值，
 * 事件回调里再取都是 null（那样查询会落到根节点，量不到列宽）。
 */
const pageInst = getCurrentInstance()

const TODAY = isoDay()
const HOUR_FROM = 8
const HOUR_TO = 21
/** 与样式里的 .hl / .slot 高度严格一致；改一处必须改两处。 */
const HOUR_H = 46
const HOURS = Array.from({ length: HOUR_TO - HOUR_FROM }, (_, i) => HOUR_FROM + i)
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

type Tone = 'high' | 'normal' | 'low'

function toast(title: string): void {
  uni.showToast({ title, icon: 'none' })
}

/* ── 日期算术（全部走本地时区，避免 toISOString 的 UTC 偏移） ───────── */

function parts(iso: string): [number, number, number] {
  const p = iso.split('-')
  return [Number(p[0]), Number(p[1]), Number(p[2])]
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = parts(iso)
  return isoDay(new Date(y, m - 1, d + n))
}

function md(iso: string): string {
  const [, m, d] = parts(iso)
  return `${m}月${d}日`
}

/** 周一为一周起点（中文日历习惯，与原型一致）。 */
function weekStartOf(iso: string): string {
  const [y, m, d] = parts(iso)
  const dt = new Date(y, m - 1, d)
  const dow = (dt.getDay() + 6) % 7
  dt.setDate(dt.getDate() - dow)
  return isoDay(dt)
}

function weekdayOf(iso: string): string {
  const [y, m, d] = parts(iso)
  return WEEKDAYS[new Date(y, m - 1, d).getDay()]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtH(x: number): string {
  const total = Math.round(x * 60)
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

const DAY_MS = 86_400_000

/** 毫秒 → 当天 "HH:MM"（一律本地时区，与 isoDay 一致） */
function hm(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `M/D HH:MM`：跨天区间的端点文案（与「今天」页同格式） */
function mdhm(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${hm(ms)}`
}

function isoOf(ms: number): string {
  return isoDay(new Date(ms))
}

/** 当天分钟数（0–1439）：网格纵向定位与安排列表排序用 */
function minutesOf(ms: number): number {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * 结束点是**排他**的：`end - 1ms` 落在哪天，任务就真正结束在哪天。
 * 22:00→次日 00:00 这种"刚好压线"的区间也只算当天，不会误标跨天。
 */
function lastIso(ms: number): string {
  return isoDay(new Date(Math.max(0, ms - 1)))
}

function toneOf(t: Task): Tone {
  if (t.pri === 'high') return 'high'
  if (t.pri === 'low') return 'low'
  return 'normal'
}

/**
 * 「全天 / 未定时」：没有绝对区间、`when` 也不是时刻的任务。
 * 这类任务不进周网格（否则会画成 13 小时的巨块），只在下方列表里出现——保留旧行为。
 */
function allDay(t: Task): boolean {
  return typeof t.startAt !== 'number' && timeOfDay(t.when) === undefined
}

/* ── 状态色（--st-waiting / --st-doing / --st-done） ─────────────── */

/** 任务当前状态：完成优先；next/doing 都算进行中；waiting 是未开始。 */
function statusKeyOf(t: Task): 'waiting' | 'doing' | 'done' {
  if (t.done) return 'done'
  return t.status === 'waiting' ? 'waiting' : 'doing'
}

/** 色值只从 STATUS_META 取，避免页面里散落硬编码颜色 */
function statusVar(t: Task): string {
  return STATUS_META[statusKeyOf(t)].cssVar
}

function statusLabel(t: Task): string {
  return STATUS_META[statusKeyOf(t)].label
}

/** 内联样式里的状态色：`var(--st-doing)` 之类 */
function statusColor(t: Task): string {
  return `var(${statusVar(t)})`
}

/** 一条任务在 `iso` 这天的可见片段（小时，落在 8:00–21:00 网格里）；看不见返回 null。 */
function gridSlice(span: { start: number; end: number }, iso: string): { start: number; end: number } | null {
  const dayStart = new Date(`${iso}T00:00:00`).getTime()
  if (Number.isNaN(dayStart)) return null
  const lo = dayStart + HOUR_FROM * 3600_000
  const hi = dayStart + HOUR_TO * 3600_000
  const s = Math.max(span.start, lo)
  const e = Math.min(span.end, hi)
  if (e <= s) return null
  return { start: (s - dayStart) / 3600_000, end: (e - dayStart) / 3600_000 }
}

/** 15 分钟对齐：拖动落点既不会碎成一堆 :07，也不会把原时刻随手抹掉。 */
function snap15(minutes: number): number {
  return Math.round(minutes / 15) * 15
}

/* ── 数据投影 ───────────────────────────────────────────────────── */

const anchor = ref(TODAY)
const calView = ref<'week' | 'month'>('week')
const detailOpen = ref(false)
const detailId = ref('')
const quickTitle = ref('')
const quickTime = ref('09:00')
/** 加完一条后重建输入框：只清 ref 可能被迟到的 input 事件写回旧文本。 */
const quickKey = ref(0)
const nowTick = ref(new Date())
/** 手机上 7 天放不进一屏：进页面先把选中那天滚进视野，否则用户看到的是空白的周一。 */
const weekScrollLeft = ref(0)

/* ── 移动模式 / 新建高亮 / 长按菜单（P0-4） ───────────────────────── */

/** 正在被"移动"的任务 id；空串 = 不在移动模式。 */
const movingId = ref('')
/** 刚被新建 / 移动过的任务与日期：给一次性高亮，让用户看见"东西就在这儿"。 */
const flashTaskId = ref('')
const flashIso = ref('')
const FLASH_MS = 1600
const HOLD_MS = 450
let flashTimer: ReturnType<typeof setTimeout> | undefined

/** 长按任务条弹出的操作菜单（MossSheet 的 menu 形态）。 */
const menuOpen = ref(false)
const menuId = ref('')
/** 删除二次确认（MossSheet 的 confirm 形态）。 */
const deleteOpen = ref(false)
const deleteId = ref('')

/** 提示条里的任务名：长标题截断，宁可省略也别把提示条撑成三行（它会压到日头）。 */
const movingTitle = computed(() => {
  const title = data.value.tasks.find((t) => t.id === movingId.value)?.title ?? ''
  return title.length > 12 ? `${title.slice(0, 12)}…` : title
})

function shortTitle(id: string, max: number): string {
  const title = data.value.tasks.find((t) => t.id === id)?.title ?? ''
  return title.length > max ? `${title.slice(0, max)}…` : title
}

const menuTitle = computed(() => (menuId.value === '' ? '' : `《${shortTitle(menuId.value, 16)}》`))

/* ── 提醒（本地闹铃）：菜单 → 提前量 → addReminder ─────────────────── */

/** 一条任务只留一个「有效（未触发）」提醒；返回它，没有则 null。 */
function reminderOf(taskId: string): Reminder | null {
  const list = data.value.reminders
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const r = list[i]
    if (r.taskId === taskId && !r.fired) return r
  }
  return null
}

function hasBell(taskId: string): boolean {
  return reminderOf(taskId) !== null
}

/** 提前量：准时 / 5 / 15 / 30 分钟（负号 = 相对开始时间往前推） */
const LEAD_OPTIONS: readonly { lead: number; label: string }[] = [
  { lead: 0, label: '准时' },
  { lead: 5, label: '提前 5 分钟' },
  { lead: 15, label: '提前 15 分钟' },
  { lead: 30, label: '提前 30 分钟' },
]

/** 时长快捷项（分钟） */
const DURATION_OPTIONS: readonly number[] = [30, 60, 120]

function durationMinutes(t: Task): number | null {
  const span = taskSpan(t)
  if (span === undefined) return null
  return Math.round((span.end - span.start) / 60_000)
}

/** 时长的人话：47 分钟 / 1.5 小时 */
function durationText(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.round((minutes / 60) * 10) / 10
    return `${h} 小时`
  }
  return `${minutes} 分钟`
}

/**
 * 长按菜单：项目随任务状态变化（有无提醒 / 当前时长），所以是 computed。
 * 下标 → 语义 key 的映射在 onMenuSelect 里一次做完，避免"第 3 项是什么"散落各处。
 */
type MenuKey = 'move' | 'edit' | 'remind' | 'duration' | 'delete'

interface MenuOption {
  key: MenuKey
  label: string
  hint: string
  danger?: boolean
}

const menuOptions = computed<MenuOption[]>(() => {
  const id = menuId.value
  const task = id === '' ? undefined : data.value.tasks.find((t) => t.id === id)
  const existing = id === '' ? null : reminderOf(id)
  const dur = task === undefined ? null : durationMinutes(task)
  return [
    { key: 'move', label: '移动 / 改期', hint: '进入移动模式：按住色块拖到别的日 / 时，或点日期格落下' },
    { key: 'edit', label: '编辑', hint: '打开任务详情，改标题、备注、状态与优先级' },
    {
      key: 'remind',
      label: existing === null ? '设置提醒' : '取消提醒',
      hint: existing === null ? '到点用本地闹铃提醒（可选提前量）' : `${mdhm(existing.at)} 触发 · 点这里取消`,
    },
    {
      key: 'duration',
      label: '时长',
      hint: dur === null ? '30 / 60 / 120 分钟' : `当前 ${durationText(dur)} · 改为 30 / 60 / 120 分钟`,
    },
    { key: 'delete', label: '删除', hint: '从日历与安排列表移除，同步到其它端（不可恢复）', danger: true },
  ]
})

/** MossSheet 只认 {label, hint, danger}；key 留在上面对照。 */
const MENU_ITEMS = computed<SheetItem[]>(() =>
  menuOptions.value.map((o) => ({ label: o.label, hint: o.hint, danger: o.danger })),
)

/* ── 二级菜单（提前量 / 时长）：同一个 MossSheet，换一份 items ────────── */

type SubKind = '' | 'remind' | 'duration'

const subOpen = ref(false)
const subKind = ref<SubKind>('')
const subId = ref('')

function subTask(): Task | undefined {
  if (subId.value === '') return undefined
  return data.value.tasks.find((t) => t.id === subId.value)
}

const subTitle = computed(() => {
  const t = subTask()
  const name = t === undefined ? '' : shortTitle(t.id, 16)
  if (subKind.value === 'remind') return `《${name}》提醒时间`
  if (subKind.value === 'duration') return `《${name}》时长`
  return ''
})

const subItems = computed<SheetItem[]>(() => {
  if (subKind.value === 'remind') {
    const t = subTask()
    const span = t === undefined ? undefined : taskSpan(t)
    return LEAD_OPTIONS.map((o) => {
      const at = span === undefined ? null : span.start - o.lead * 60_000
      const hint = at === null
        ? '这条任务还没有日期 / 时刻'
        : `${mdhm(at)} 触发${at <= Date.now() ? '（已过去）' : ''}`
      return { label: o.label, hint }
    })
  }
  if (subKind.value === 'duration') {
    const t = subTask()
    const span = t === undefined ? undefined : taskSpan(t)
    return DURATION_OPTIONS.map((min) => ({
      label: durationText(min),
      hint: span === undefined
        ? '这条任务还没有日期 / 时刻'
        : `${hm(span.start)}–${hm(span.start + min * 60_000)}`,
    }))
  }
  return []
})

const deleteMessage = computed(() => {
  const title = shortTitle(deleteId.value, 16)
  return `「${title}」删除后不可恢复，日历网格与下方安排列表里会立即消失。`
})

watch(
  () => work.deviceId,
  () => {
    detailOpen.value = false
    movingId.value = ''
    menuOpen.value = false
    menuId.value = ''
    deleteOpen.value = false
    deleteId.value = ''
    resetDrag()
  },
)

/** 本周 7 天的日期（周一 → 周日）；网格、事件投影、滚动定位都按它算。 */
const weekStart = computed(() => weekStartOf(anchor.value))
const weekIsos = computed<string[]>(() =>
  Array.from({ length: 7 }, (_, i) => addDays(weekStart.value, i)),
)

interface RawItem {
  t: Task
  /** 这天网格里的起止（小时，8 = 8:00），已裁到 8:00–21:00 窗口 */
  start: number
  end: number
  /** 跨天：这天之外还有部分（起 / 止分别标） */
  crossStart: boolean
  crossEnd: boolean
  /** 整条任务的原时长（毫秒，不是裁剪后的）：拖拽改期时按它保持时长 */
  duration: number
}

interface CalEvent {
  id: string
  title: string
  top: number
  height: number
  leftPct: number
  widthPct: number
  /** 空间 / 优先级色：只画左侧细条，不再当主体底色 */
  tone: Tone
  /** 状态色 `var(--st-*)`：事件条主体铺色 */
  st: string
  done: boolean
  range: string
  /** 跨天：这一条在当天只是其中一段（虚线边 + 「跨天 / 次日」文案） */
  cross: boolean
  /** 原时长（毫秒）：拖动时幽灵条与落点都按它算 */
  duration: number
}

/**
 * 一天的网格事件：先用 `tasksOnDay` 取"这天覆盖到的任务"（含跨天），
 * 再用 `taskSpan` 裁出当天 8:00–21:00 的那一段，最后排轨道。
 */
function layoutDay(iso: string): CalEvent[] {
  const raw: RawItem[] = []
  for (const t of tasksOnDay(data.value.tasks, iso)) {
    // 全天 / 未定时不在网格里画（否则会是一条 13 小时的巨块），下方列表里有它
    if (allDay(t)) continue
    const span = taskSpan(t)
    if (span === undefined) continue
    const slice = gridSlice(span, iso)
    if (slice === null) continue
    raw.push({
      t,
      start: slice.start,
      end: slice.end,
      crossStart: isoOf(span.start) !== iso,
      crossEnd: lastIso(span.end) !== iso,
      duration: span.end - span.start,
    })
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end)

  const list: CalEvent[] = []
  let cluster: RawItem[] = []
  let clusterEnd = -1

  /**
   * 一周里同一天可能撞时间：用"轨道"算法排成并排。
   * 不做这一步的话，两条 9:30 会完全重叠，用户只能看到一条。
   */
  const flush = (): void => {
    if (cluster.length === 0) return
    const laneEnds: number[] = []
    const placed: { item: RawItem; lane: number }[] = []
    for (const item of cluster) {
      let lane = laneEnds.findIndex((end) => end <= item.start)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(item.end)
      } else {
        laneEnds[lane] = item.end
      }
      placed.push({ item, lane })
    }
    const lanes = Math.max(1, laneEnds.length)
    const width = 96 / lanes
    for (const p of placed) {
      // 跨天的那一端写「跨天 / 次日」，一眼看出这段是被切开的
      const head = p.item.crossStart ? '跨天' : fmtH(p.item.start)
      const tail = p.item.crossEnd ? '次日' : fmtH(p.item.end)
      list.push({
        id: p.item.t.id,
        title: p.item.t.title,
        top: Math.round((p.item.start - HOUR_FROM) * HOUR_H),
        height: Math.max(20, Math.round((p.item.end - p.item.start) * HOUR_H) - 4),
        leftPct: 2 + p.lane * width,
        widthPct: width - 2,
        tone: toneOf(p.item.t),
        st: statusColor(p.item.t),
        done: p.item.t.done,
        range: `${head}–${tail}`,
        cross: p.item.crossStart || p.item.crossEnd,
        duration: p.item.duration,
      })
    }
    cluster = []
    clusterEnd = -1
  }

  for (const item of raw) {
    if (cluster.length > 0 && item.start >= clusterEnd) flush()
    cluster.push(item)
    clusterEnd = Math.max(clusterEnd, item.end)
  }
  flush()

  return list
}

const eventsByDate = computed<Record<string, CalEvent[]>>(() => {
  const out: Record<string, CalEvent[]> = {}
  for (const iso of weekIsos.value) out[iso] = layoutDay(iso)
  return out
})

interface WeekDay {
  iso: string
  weekday: string
  md: string
  isToday: boolean
  events: CalEvent[]
}

const weekDays = computed<WeekDay[]>(() =>
  weekIsos.value.map((iso) => {
    const [, m, d] = parts(iso)
    return {
      iso,
      weekday: weekdayOf(iso),
      md: `${m}/${d}`,
      isToday: iso === TODAY,
      events: eventsByDate.value[iso] ?? [],
    }
  }),
)

const weekLabel = computed(() => {
  const days = weekDays.value
  return `${md(days[0].iso)} – ${md(days[6].iso)}`
})

const monthLabel = computed(() => {
  const [y, m] = parts(anchor.value)
  return `${y}年${m}月`
})

const barLabel = computed(() => (calView.value === 'week' ? weekLabel.value : monthLabel.value))

interface MonthCell {
  iso: string
  d: number
  out: boolean
  isToday: boolean
  sel: boolean
  /** 状态色（var(--st-*)）小圆点：颜色直接读状态，不再用优先级 */
  dots: string[]
}

const monthCells = computed<MonthCell[]>(() => {
  const [y, m] = parts(anchor.value)
  const first = new Date(y, m - 1, 1)
  const lead = (first.getDay() + 6) % 7
  const start = isoDay(new Date(y, m - 1, 1 - lead))
  return Array.from({ length: 42 }, (_, i) => {
    const iso = addDays(start, i)
    const [yy, mm, dd] = parts(iso)
    // 与安排列表同源：跨天任务在它覆盖的每一天都有点
    const tasks = tasksOnDay(data.value.tasks, iso)
    return {
      iso,
      d: dd,
      out: yy !== y || mm !== m,
      isToday: iso === TODAY,
      sel: iso === anchor.value,
      dots: tasks.slice(0, 3).map((t) => statusColor(t)),
    }
  })
})

interface AgendaItem {
  id: string
  title: string
  range: string
  dev: string
  /** 状态色，左侧 3px 色条 + 状态文案取它 */
  st: string
  stLabel: string
  done: boolean
  /** 跨天：这条在选中日只是其中一段 */
  cross: boolean
  bell: boolean
}

/** 跨天区间的完整文案：`10/24 22:00 → 10/25 07:00`（同「今天」页） */
function spanRange(span: { start: number; end: number }): string {
  return `${mdhm(span.start)} → ${mdhm(span.end)}`
}

const agenda = computed<AgendaItem[]>(() => {
  const iso = anchor.value
  const dayStart = new Date(`${iso}T00:00:00`).getTime()
  // 与「今天」页同源：覆盖到这一天的任务（含跨天）全部出现
  const list = tasksOnDay(data.value.tasks, iso).filter((t) => !(t.done && allDay(t)))
  const rank = (t: Task): number => {
    const span = taskSpan(t)
    if (span === undefined) return 24 * 60 + 3 // 未定时排最后
    if (allDay(t)) return 24 * 60 + 2 // 全天排在定时之后、未定时之前
    return minutesOf(Math.max(span.start, dayStart))
  }
  return list
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map((t) => {
      const span = taskSpan(t)
      const cross = span !== undefined && (isoOf(span.start) !== iso || lastIso(span.end) !== iso)
      let range = '未定时'
      if (span !== undefined) {
        if (allDay(t)) range = '全天'
        else if (cross) range = spanRange(span)
        else range = `${hm(span.start)}–${hm(span.end)}`
      }
      return {
        id: t.id,
        title: t.title,
        range,
        st: statusColor(t),
        stLabel: statusLabel(t),
        done: t.done,
        cross,
        bell: hasBell(t.id),
        dev: t.dev,
      }
    })
})

const agendaTitle = computed(() =>
  anchor.value === TODAY ? '今日安排' : `${md(anchor.value)} · ${weekdayOf(anchor.value)}`,
)

const nowY = computed(() => {
  const d = nowTick.value
  const h = d.getHours() + d.getMinutes() / 60
  if (h < HOUR_FROM || h > HOUR_TO) return -1
  return Math.round((h - HOUR_FROM) * HOUR_H)
})

/* ── 交互 ───────────────────────────────────────────────────────── */

/**
 * 把选中日滚进视野。
 * 手机上一屏只放得下 3 列多，进页面停在周一等于"今天什么都没排"；
 * 平板七列全放得下，scrollLeft 会被浏览器自己夹到 0，无副作用。
 */
function focusSelectedDay(): void {
  const idx = weekDays.value.findIndex((d) => d.iso === anchor.value)
  const target = idx < 0 ? 0 : Math.max(0, 38 + idx * 96 - 44)
  // 先归零再赋值：同一个数值不会触发 scroll-view 的滚动监听
  weekScrollLeft.value = 0
  nextTick(() => { weekScrollLeft.value = target })
}

function setCalView(v: 'week' | 'month'): void {
  if (calView.value === v) return
  // 周网格要拆掉了：拖到一半的幽灵条必须一起收掉，否则它留在屏幕上成了孤儿
  cancelDrag()
  calView.value = v
  haptic('light')
}

function shift(delta: number): void {
  if (calView.value === 'month') {
    const [y, m, d] = parts(anchor.value)
    const first = new Date(y, m - 1 + delta, 1)
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
    anchor.value = isoDay(new Date(first.getFullYear(), first.getMonth(), Math.min(d, lastDay)))
  } else {
    anchor.value = addDays(anchor.value, delta * 7)
    focusSelectedDay()
  }
  haptic('light')
}

function goToday(): void {
  anchor.value = TODAY
  focusSelectedDay()
  haptic('light')
  toast('回到今天')
}

function selectDate(iso: string): void {
  if (anchor.value === iso) return
  anchor.value = iso
  haptic('light')
}

function pickMonthDay(iso: string): void {
  anchor.value = iso
  calView.value = 'week'
  haptic('light')
}

function openTask(id: string): void {
  // 长按 / 按住之后平台多半还会补一次 tap：吃掉它，否则菜单刚弹出就被详情盖住。
  if (isSwallowedTap(id)) {
    swallowId = ''
    swallowUntil = 0
    return
  }
  openDetail(id)
}

/** 打开共用详情抽屉。菜单里的「编辑」也走这里（绕开吞点击逻辑，否则会被自己吃掉）。 */
function openDetail(id: string): void {
  cancelDrag()
  movingId.value = ''
  detailId.value = id
  detailOpen.value = true
  haptic('light')
}

/* ── 长按菜单（ActionSheet 风格，MossSheet 页内自绘，跨端一致） ───────── */

/**
 * 长按 / 按住后的"吃掉"窗口：只针对刚被长按的那一条任务。
 * 平台在抬手时会补发一次 tap（H5 是 click），不吞掉就会立刻打开详情、把菜单顶掉。
 */
let swallowId = ''
let swallowUntil = 0

function swallowTap(id: string, ms: number): void {
  swallowId = id
  swallowUntil = Date.now() + ms
}

function isSwallowedTap(id: string): boolean {
  return id === swallowId && Date.now() < swallowUntil
}

/** 桌面浏览器没有长按手势（uni-h5 的 longpress 只挂在触摸事件上），补一个按住等价入口。 */
let holdTimer: ReturnType<typeof setTimeout> | undefined

function clearHold(): void {
  if (holdTimer === undefined) return
  clearTimeout(holdTimer)
  holdTimer = undefined
}

function holdStart(id: string): void {
  clearHold()
  holdTimer = setTimeout(() => {
    holdTimer = undefined
    openMenu(id)
  }, HOLD_MS)
}

/**
 * 松手：平台补发的那次 tap 紧跟其后，所以这时把"吃掉"窗口收窄到 400ms——
 * 刚刚那一下被忽略，之后用户再点这条任务就是正常开详情。
 */
function onBarRelease(): void {
  clearHold()
  if (swallowUntil > Date.now()) swallowUntil = Date.now() + 400
}

function openMenu(id: string): void {
  // 拖动中 / 已经在移动这一条时，长按不再叠一层菜单
  if (drag.value !== null) return
  if (movingId.value === id) return
  clearHold()
  swallowTap(id, 1200)
  menuId.value = id
  menuOpen.value = true
  haptic('medium')
}

function onMenuSelect(index: number): void {
  const id = menuId.value
  // 先取选项再清 menuId：menuOptions 依赖 menuId，清早了就查不到这一项
  const option = menuOptions.value[index]
  menuOpen.value = false
  menuId.value = ''
  if (id === '' || option === undefined) return
  if (data.value.tasks.find((t) => t.id === id) === undefined) {
    toast('这条任务已经不在了')
    return
  }
  if (option.key === 'move') {
    startMove(id)
    return
  }
  if (option.key === 'edit') {
    openDetail(id)
    return
  }
  if (option.key === 'remind') {
    toggleReminder(id)
    return
  }
  if (option.key === 'duration') {
    openSub('duration', id)
    return
  }
  askDelete(id)
}

/* ── 二级菜单：设置提前量 / 改时长 ─────────────────────────────────── */

function openSub(kind: SubKind, id: string): void {
  const task = data.value.tasks.find((t) => t.id === id)
  if (task === undefined) {
    toast('这条任务已经不在了')
    return
  }
  // 提醒 / 时长都要有真实时刻：全天任务没有"几点"，先别让它进这两条路径
  if ((kind === 'remind' || kind === 'duration') && (taskSpan(task) === undefined || allDay(task))) {
    toast(kind === 'remind' ? '先排个具体的日期时间，再来设提醒' : '全天任务没有时刻，先改成带时间的日程')
    return
  }
  subId.value = id
  subKind.value = kind
  subOpen.value = true
  haptic('light')
}

function onSubSelect(index: number): void {
  const id = subId.value
  const kind = subKind.value
  subOpen.value = false
  subKind.value = ''
  subId.value = ''
  if (id === '') return
  if (kind === 'remind') {
    const opt = LEAD_OPTIONS[index]
    if (opt !== undefined) setReminder(id, opt.lead)
    return
  }
  if (kind === 'duration') {
    const minutes = DURATION_OPTIONS[index]
    if (minutes !== undefined) setDuration(id, minutes)
  }
}

/* ── 提醒：写入 / 取消 / 通知投递 ─────────────────────────────────── */

/** 设置提醒（同一条任务只保留一个有效提醒，重复设置即替换）。 */
function setReminder(taskId: string, lead: number): void {
  const task = data.value.tasks.find((t) => t.id === taskId)
  if (task === undefined) {
    toast('这条任务已经不在了')
    return
  }
  const span = taskSpan(task)
  if (span === undefined) {
    toast('先给这条排个日期，再来设提醒')
    return
  }
  const at = span.start - lead * 60_000
  if (at <= Date.now()) {
    toast('这个提前量已经早于现在了，换一个')
    return
  }
  const existing = reminderOf(taskId)
  if (existing !== null) removeReminder(existing.id)
  addReminder(taskId, at, task.title === '' ? '日程提醒' : task.title)
  // 只有用户第一次设提醒时才申请通知权限（进入页面时绝不主动弹）
  void ensureNotifyPermission()
  haptic('medium')
  toast(`提醒已设在 ${mdhm(at)}`)
}

/** 菜单项是「取消提醒」时走这里。 */
function toggleReminder(id: string): void {
  const existing = reminderOf(id)
  if (existing === null) {
    openSub('remind', id)
    return
  }
  removeReminder(existing.id)
  haptic('light')
  toast('已取消提醒')
}

/**
 * 改时长：起点不动，只换 endAt（30 / 60 / 120 分钟）。
 * 走 scheduleTask 而不是直接写 endAt，date/when 才会跟着绝对区间保持一致。
 */
function setDuration(taskId: string, minutes: number): void {
  const task = data.value.tasks.find((t) => t.id === taskId)
  if (task === undefined) {
    toast('这条任务已经不在了')
    return
  }
  const span = taskSpan(task)
  if (span === undefined || allDay(task)) {
    toast('全天任务没有时刻，先改成带时间的日程')
    return
  }
  scheduleTask(taskId, span.start, span.start + minutes * 60_000)
  flashFor(taskId, isoOf(span.start))
  haptic('medium')
  toast(`时长改为 ${durationText(minutes)}`)
}

/**
 * H5 通知权限：只在设提醒时请求一次。
 * 用户拒绝就降级到 showModal，不反复骚扰。
 */
async function ensureNotifyPermission(): Promise<void> {
  if (typeof window === 'undefined') return
  const N = (window as Window & { Notification?: typeof Notification }).Notification
  if (N === undefined) return
  if (N.permission !== 'default') return
  try {
    const res = await N.requestPermission()
    if (res !== 'granted') toast('未获得通知权限，到点改用弹窗提醒')
  } catch {
    /* 不支持 / 被策略拦截：静默降级到弹窗 */
  }
}

/** App 端：plus.push 本地通知（H5 里 plus 不存在，所以一律 typeof 探测）。 */
function nativeNotify(label: string): boolean {
  if (typeof plus === 'undefined') return false
  const push = plus.push
  if (push === undefined || push === null || typeof push.createMessage !== 'function') return false
  try {
    push.createMessage(label, '', { title: '日程提醒' })
    return true
  } catch {
    return false
  }
}

/** H5：权限已授予才用 Web Notification；未授权 / 移动端不支持时返回 false 让调用方降级。 */
function webNotify(label: string): boolean {
  if (typeof window === 'undefined') return false
  const N = (window as Window & { Notification?: typeof Notification }).Notification
  if (N === undefined || N.permission !== 'granted') return false
  try {
    new N('日程提醒', { body: label })
    return true
  } catch {
    // 移动端 Chrome 要求 ServiceWorker 才能构造 Notification：构造失败即降级
    return false
  }
}

/** 最后一级降级：振动 + 页内 modal，用户一定看得见。 */
function modalNotify(label: string): Promise<void> {
  try {
    uni.vibrateLong({ fail: () => {} })
  } catch {
    /* 部分平台没有振动马达 */
  }
  return new Promise((resolve) => {
    uni.showModal({
      title: '⏰ 日程提醒',
      content: label,
      showCancel: false,
      confirmText: '知道了',
      complete: () => resolve(),
    })
  })
}

/** 正在投递：避免 modal 还开着时下一轮轮询再弹一遍。 */
let pumping = false

/**
 * 轮询触发：到点 → 先 markReminderFired（保证不重复）→ 按 App / H5 / modal 逐级降级。
 * 多条同时到期时串行投递，弹窗不会互相顶掉。
 */
async function pumpReminders(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    const due = dueReminders()
    for (const r of due) {
      markReminderFired(r.id)
      const label = r.label === '' ? '有一条日程到点了' : r.label
      if (nativeNotify(label)) continue
      if (webNotify(label)) continue
      await modalNotify(label)
    }
  } finally {
    pumping = false
  }
}

const REMIND_POLL_MS = 15_000
let remindTimer: ReturnType<typeof setInterval> | undefined

function startReminderPoll(): void {
  if (remindTimer !== undefined) return
  remindTimer = setInterval(() => { void pumpReminders() }, REMIND_POLL_MS)
  void pumpReminders()
}

function stopReminderPoll(): void {
  if (remindTimer === undefined) return
  clearInterval(remindTimer)
  remindTimer = undefined
}

/* ── 删除（二次确认 → removeTask） ─────────────────────────────────── */

function askDelete(id: string): void {
  if (data.value.tasks.find((t) => t.id === id) === undefined) {
    toast('这条任务已经不在了')
    return
  }
  deleteId.value = id
  deleteOpen.value = true
  haptic('light')
}

function doDelete(): void {
  const id = deleteId.value
  deleteOpen.value = false
  deleteId.value = ''
  if (id === '') return
  const task = data.value.tasks.find((t) => t.id === id)
  if (task === undefined) {
    toast('这条任务已经不在了')
    return
  }
  // 先把"引用这条任务"的浮层全部收掉，再删；否则详情抽屉会停在一条已不存在的任务上
  if (movingId.value === id) movingId.value = ''
  if (detailId.value === id) detailOpen.value = false
  cancelDrag()
  removeTask(id)
  haptic('medium')
  toast('已删除')
}

/* ── 移动模式：拖动排期（手势） + 点格子（兜底） ───────────────────── */

interface DragState {
  id: string
  title: string
  tone: Tone
  /** 状态色：幽灵条主体铺它（空间色只留左侧细条） */
  st: string
  /** 幽灵条尺寸（px）与手指抓取偏移（相对幽灵条顶部） */
  width: number
  height: number
  grab: number
  startX: number
  startY: number
  /** 幽灵条左上角（视口坐标，position: fixed） */
  x: number
  y: number
  /** 起点列与起点色块顶部（px，相对网格顶部）——落点由位移推出来 */
  startIso: string
  startCol: number
  baseTop: number
  targetIso: string
  /** 落点（当天分钟数，15 分钟对齐）；targetHour 只是给小时格高亮用 */
  targetMinute: number
  targetHour: number
  /** 原时长（毫秒）：松手只换起点，时长原样带走 */
  duration: number
  moved: boolean
}

const drag = ref<DragState | null>(null)
/** 手指移动超过这个距离才算"拖动"，否则还是当作一次点击。 */
const DRAG_SLOP = 6
/** 实测列宽（px）。滚动不影响宽度，所以只量一次就够。 */
let colWidth = 96
let measuring = false

const dragIso = computed(() => (drag.value === null || !drag.value.moved ? '' : drag.value.targetIso))
const dragHour = computed(() => (drag.value === null || !drag.value.moved ? -1 : drag.value.targetHour))

/** 当天分钟数 → "HH:MM" */
function minuteLabel(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

const dragLabel = computed(() => {
  const d = drag.value
  if (d === null) return ''
  return `${md(d.targetIso)} ${minuteLabel(d.targetMinute)}`
})

/** 提示条上的一句话：拖动中报落点，未拖时报"还能怎么落"。 */
const moveHint = computed(() => {
  const d = drag.value
  if (d !== null && d.moved) return `松手落到 ${md(d.targetIso)} ${minuteLabel(d.targetMinute)} · 时长不变`
  return calView.value === 'week'
    ? '按住色块拖动 · 或点日期格 / 日头落下'
    : '点任意日期把任务移过去'
})

const ghostStyle = computed(() => {
  const d = drag.value
  if (d === null) return ''
  return `left:${Math.round(d.x)}px;top:${Math.round(d.y)}px;width:${d.width}px;height:${d.height}px;--st:${d.st}`
})

/**
 * 量 7 天列宽。H5 的 boundingClientRect 会把 top 减掉 window-top（安全区），
 * 所以这里**只用 width**：列宽在横向滚动下不变，落点用"起点列 + 位移/列宽"推，
 * 既不受滚动影响，也不受坐标系差异影响。
 */
function measureColumns(): void {
  if (measuring) return
  measuring = true
  const query = uni.createSelectorQuery()
  if (pageInst !== null) query.in(pageInst.proxy ?? pageInst)
  query.selectAll('.daycol').boundingClientRect()
  query.exec((res: any) => {
    measuring = false
    const list: any[] | null = Array.isArray(res) ? res[0] : null
    if (list === null || list.length === 0) return
    let sum = 0
    let n = 0
    for (const r of list) {
      const w = Number(r?.width ?? 0)
      if (Number.isFinite(w) && w > 20) {
        sum += w
        n += 1
      }
    }
    if (n > 0) colWidth = sum / n
  })
}

function pointOf(e: any): { x: number; y: number } | null {
  const t = e?.touches?.[0] ?? e?.changedTouches?.[0]
  if (t !== undefined && t !== null && Number.isFinite(Number(t.clientX))) {
    return { x: Number(t.clientX), y: Number(t.clientY) }
  }
  if (Number.isFinite(Number(e?.clientX)) && Number.isFinite(Number(e?.clientY))) {
    return { x: Number(e.clientX), y: Number(e.clientY) }
  }
  return null
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function startDrag(id: string, iso: string, ev: CalEvent, x: number, y: number): void {
  if (movingId.value !== id) return
  const startCol = weekDays.value.findIndex((d) => d.iso === iso)
  if (startCol < 0) return
  const width = Math.max(64, Math.round(colWidth - 6))
  const height = Math.max(26, ev.height)
  // 抓取点固定在手指下方一点点：幽灵条不会整块跳到指尖，也不会遮住落点
  const grab = Math.min(height - 6, Math.max(10, Math.round(height / 2)))
  // 起点分钟数 = 色块 top（含 :30 这类偏移）换算回当天分钟，再对齐 15 分钟
  const startMinute = clampInt(
    snap15(Math.round((HOUR_FROM * 60) + (ev.top / HOUR_H) * 60)),
    HOUR_FROM * 60,
    HOUR_TO * 60 - 15,
  )
  drag.value = {
    id,
    title: ev.title,
    tone: ev.tone,
    st: ev.st,
    width,
    height,
    grab,
    startX: x,
    startY: y,
    x: x - width / 2,
    y: y - grab,
    startIso: iso,
    startCol,
    baseTop: ev.top,
    targetIso: iso,
    targetMinute: startMinute,
    targetHour: Math.floor(startMinute / 60),
    duration: Math.max(15 * 60_000, ev.duration),
    moved: false,
  }
  haptic('medium')
}

function moveDrag(x: number, y: number): void {
  const d = drag.value
  if (d === null) return
  const dx = x - d.startX
  const dy = y - d.startY
  if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return
  d.moved = true
  d.x = x - d.width / 2
  d.y = y - d.grab
  const step = Math.round(dx / colWidth)
  const col = clampInt(d.startCol + step, 0, weekDays.value.length - 1)
  const iso = weekDays.value[col]?.iso ?? d.startIso
  // 分钟：起点色块 top + 竖向位移，换回当天分钟数并对齐 15 分钟（比整点更贴手）
  const minute = clampInt(
    snap15(Math.round(HOUR_FROM * 60 + ((d.baseTop + dy) / HOUR_H) * 60)),
    HOUR_FROM * 60,
    HOUR_TO * 60 - 15,
  )
  d.targetIso = iso
  d.targetMinute = minute
  d.targetHour = Math.floor(minute / 60)
}

/** 松手：commit=false 用于取消（切视图 / 删任务 / touchcancel）。 */
function endDrag(commit: boolean): void {
  detachMouse()
  const d = drag.value
  drag.value = null
  if (d === null) return
  if (!commit || !d.moved) return
  const task = data.value.tasks.find((t) => t.id === d.id)
  if (task === undefined) {
    toast('这条任务已经不在了')
    return
  }
  const iso = d.targetIso
  const [y, m, day] = parts(iso)
  const start = new Date(y, m - 1, day, Math.floor(d.targetMinute / 60), d.targetMinute % 60, 0, 0).getTime()
  movingId.value = ''
  swallowTap(d.id, 600)
  if (!Number.isFinite(start)) {
    toast('落点算不出来，换一格试试')
    return
  }
  const span = taskSpan(task)
  // 时长不变：以 taskSpan 为唯一来源（拖动期间任务被别处改过也不会算错）
  const duration = Math.max(15 * 60_000, span === undefined ? d.duration : span.end - span.start)
  if (span !== undefined && span.start === start && span.end - span.start === duration) {
    toast('位置没变')
    return
  }
  scheduleTask(d.id, start, start + duration)
  flashFor(d.id, iso)
  // 周视图把选中日跟过去：任务同时出现在下方安排列表里，改期结果一眼可见
  anchor.value = iso
  haptic('light')
  toast(`已移到 ${md(iso)} · ${minuteLabel(d.targetMinute)}（时长不变）`)
}

function cancelDrag(): void {
  if (drag.value === null) {
    detachMouse()
    return
  }
  drag.value = null
  detachMouse()
}

function resetDrag(): void {
  drag.value = null
  detachMouse()
}

/* ── 拖动入口（触摸 / 鼠标共用同一套 moveDrag / endDrag） ───────────── */

/** 触摸起点：已经在移动这条 → 直接开拖；否则顺手量一次列宽，进移动模式后立刻可用。 */
function barTouchStart(id: string, iso: string, ev: CalEvent, e: any): void {
  const p = pointOf(e)
  if (p === null) return
  if (movingId.value === id) {
    clearHold()
    if (drag.value !== null) return
    startDrag(id, iso, ev, p.x, p.y)
    return
  }
  measureColumns()
}

function barTouchMove(e: any): void {
  clearHold()
  const d = drag.value
  if (d === null) return
  const p = pointOf(e)
  if (p === null) return
  // 拖动期间阻止页面 / 网格跟着滚：否则幽灵条的参照系在动，落点会跳
  const pe = e as { preventDefault?: () => void; cancelable?: boolean }
  if (typeof pe.preventDefault === 'function' && pe.cancelable !== false) pe.preventDefault()
  moveDrag(p.x, p.y)
}

function barTouchEnd(e?: any): void {
  /*
   * "幽灵点击"：H5 在 touchend 之后会按落点补发一次 click。
   *   - 长按弹了菜单：这一下会砸在遮罩上，菜单"闪一下就没了"；
   *   - 拖完松手：这一下会落在目标格上，等于刚搬完又新建一条空任务。
   * 这两种情况都必须把抬手事件吞掉（preventDefault 能阻止后续的合成 click）。
   * 普通点按不能吞：任务详情、点格子新建全靠它。
   */
  if (e !== undefined && (menuOpen.value || drag.value !== null)) {
    const pe = e as { preventDefault?: () => void; cancelable?: boolean }
    if (typeof pe.preventDefault === 'function' && pe.cancelable !== false) pe.preventDefault()
  }
  if (drag.value !== null) {
    // 以抬手那一点的坐标收尾（最后一次 touchmove 可能比手指落后一帧）
    const p = e === undefined ? null : pointOf(e)
    if (p !== null) moveDrag(p.x, p.y)
    endDrag(true)
    return
  }
  onBarRelease()
}

function barTouchCancel(): void {
  if (drag.value !== null) {
    endDrag(false)
    return
  }
  clearHold()
}

function barMouseDown(id: string, iso: string, ev: CalEvent, e: any): void {
  const p = pointOf(e)
  if (p === null) return
  if (movingId.value === id) {
    if (drag.value !== null) return
    startDrag(id, iso, ev, p.x, p.y)
    attachMouse()
    return
  }
  holdStart(id)
}

/* 鼠标拖到网格外也要跟手：监听挂在 document 上，松手即摘。 */
function onDocMouseMove(e: MouseEvent): void {
  if (drag.value === null) return
  if (e.cancelable) e.preventDefault()
  moveDrag(e.clientX, e.clientY)
}

function onDocMouseUp(): void {
  if (drag.value !== null) endDrag(true)
}

function attachMouse(): void {
  if (typeof document === 'undefined') return
  document.addEventListener('mousemove', onDocMouseMove)
  document.addEventListener('mouseup', onDocMouseUp)
}

function detachMouse(): void {
  if (typeof document === 'undefined') return
  document.removeEventListener('mousemove', onDocMouseMove)
  document.removeEventListener('mouseup', onDocMouseUp)
}

function startMove(id: string): void {
  if (movingId.value === id) return
  movingId.value = id
  swallowTap(id, 4000)
  haptic('medium')
  // 提前量一次列宽：拖动那一刻就不用等异步查询回来
  if (calView.value === 'week') nextTick(() => measureColumns())
}

function cancelMove(): void {
  if (movingId.value === '') return
  cancelDrag()
  movingId.value = ''
  haptic('light')
  toast('已取消移动')
}

/** 一次性高亮：动画结束由定时器摘掉类名。 */
function flashFor(id: string, iso: string): void {
  flashTaskId.value = id
  flashIso.value = iso
  if (flashTimer !== undefined) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashTaskId.value = ''
    flashIso.value = ''
  }, FLASH_MS)
}

/**
 * 落点：只改 `date`，`when` 原样带走（时间型 when 于是自动跟着任务搬到新的一天）。
 * 走 updateTask，落盘 / 同步都留给数据层。
 */
function moveTo(iso: string): void {
  const id = movingId.value
  if (id === '') return
  cancelDrag()
  movingId.value = ''
  swallowTap(id, 400)
  const task = data.value.tasks.find((t) => t.id === id)
  if (task === undefined) {
    toast('这条任务已经不在了')
    return
  }
  const span = taskSpan(task)
  if (span === undefined || allDay(task)) {
    // 未定时 / 全天：只认日期，别凭空给它编一个时刻
    updateTask(id, { date: iso })
    flashFor(id, iso)
    if (calView.value === 'week') anchor.value = iso
    haptic('light')
    toast(span === undefined ? `已移到 ${md(iso)}` : `已移到 ${md(iso)} · 全天`)
    return
  }
  // 带时刻的任务：保留原时刻与原时长，只把绝对区间整体平移到新的一天
  const [y, m, d] = parts(iso)
  const minute = minutesOf(span.start)
  const duration = span.end - span.start
  const start = new Date(y, m - 1, d, Math.floor(minute / 60), minute % 60, 0, 0).getTime()
  if (!Number.isFinite(start)) {
    toast('落点算不出来，换一天试试')
    return
  }
  scheduleTask(id, start, start + duration)
  flashFor(id, iso)
  // 周视图里把选中日跟过去，任务同时出现在下方安排列表里，改期结果一眼可见
  if (calView.value === 'week') anchor.value = iso
  haptic('light')
  toast(`已移到 ${md(iso)} · ${hm(start)}（时长不变）`)
}

/** 周视图日头 / 天列：移动模式下落点，平时选日期。 */
function tapDate(iso: string): void {
  if (movingId.value !== '') {
    moveTo(iso)
    return
  }
  selectDate(iso)
}

/**
 * 周视图小时格：平时以这天 + 这小时新建；移动模式下沉成日期落点
 * （需求约定改期只改日期，时间保持原样）。
 */
function slotTap(iso: string, hour: number): void {
  if (movingId.value !== '') {
    moveTo(iso)
    return
  }
  const when = `${pad(hour)}:00`
  const task = addTask('新任务', { date: iso, when })
  anchor.value = iso
  flashFor(task.id, iso)
  haptic('light')
  toast(`已新建 ${md(iso)} ${when}`)
}

/** 月视图空白格：以这天新建（全天）；移动模式下是落点。 */
function tapMonthCell(iso: string): void {
  if (movingId.value !== '') {
    moveTo(iso)
    return
  }
  const task = addTask('新任务', { date: iso, when: '全天' })
  flashFor(task.id, iso)
  haptic('light')
  toast(`已新建 ${md(iso)} · 全天`)
}

/** 月视图日期数字：跳到那一周（保留原来的"找密度 → 再进周"路径）。 */
function tapMonthDay(iso: string): void {
  if (movingId.value !== '') {
    moveTo(iso)
    return
  }
  pickMonthDay(iso)
}

/**
 * 事件条样式：几何在 left/top/width/height，颜色只给 `--st`（状态色）。
 * 空间 / 优先级色仍由 `.high / .normal / .low` 提供，只画左侧 3px 细条。
 */
function evStyle(e: CalEvent): string {
  return `top:${e.top}px;height:${e.height}px;left:${e.leftPct}%;width:${e.widthPct}%;--st:${e.st}`
}

function onPickTime(e: any): void {
  const v = String(e?.detail?.value ?? '')
  if (v !== '') quickTime.value = v
}

function quickAdd(e?: any): void {
  // 同上：确认事件里带的是输入框终值，比 v-model 可靠
  const raw = e?.detail?.value
  const title = String(typeof raw === 'string' ? raw : quickTitle.value).trim()
  if (title === '') {
    toast('先写一句要办的事')
    return
  }
  addTask(title, { date: anchor.value, when: quickTime.value })
  quickTitle.value = ''
  quickKey.value += 1
  haptic('light')
  toast(`已加到 ${md(anchor.value)} ${quickTime.value}`)
}

/* ── 新建（开始 / 结束各带日期 + 时间，结束可跨天） ─────────────────── */

const createOpen = ref(false)
const createTitle = ref('')
const createDate = ref(TODAY)
const createTime = ref('09:00')
const createEndDate = ref(TODAY)
const createEndTime = ref('10:00')
/** 每次打开重建输入框：只清 ref 可能被迟到的 input 事件写回旧文本。 */
const createKey = ref(0)

/** picker 的 change 事件里带的是终值，比 v-model 可靠。 */
function pickValue(e: any): string {
  const v = e?.detail?.value
  return typeof v === 'string' ? v : ''
}

function createStartMs(): number {
  const [y, m, d] = parts(createDate.value)
  const t = timeOfDay(createTime.value)
  if (t === undefined) return Number.NaN
  return new Date(y, m - 1, d, t.h, t.m, 0, 0).getTime()
}

function createEndMs(): number {
  const [y, m, d] = parts(createEndDate.value)
  const t = timeOfDay(createEndTime.value)
  if (t === undefined) return Number.NaN
  return new Date(y, m - 1, d, t.h, t.m, 0, 0).getTime()
}

/** 结束时间从开始时间推：默认 +1 小时（跨天自然进位到次日）。 */
function setEndFromStart(startMs: number): void {
  if (!Number.isFinite(startMs)) return
  const end = startMs + 3600_000
  createEndDate.value = isoOf(end)
  createEndTime.value = hm(end)
}

/** 开始晚于结束时，结束自动跟到开始 + 1 小时，省得用户来回改两个字段。 */
function keepCreateOrder(): void {
  const s = createStartMs()
  const e = createEndMs()
  if (!Number.isFinite(s) || !Number.isFinite(e)) return
  if (e <= s) setEndFromStart(s)
}

function openCreate(): void {
  const iso = anchor.value
  // 默认落在"下一个整点"（今天）或 9:00（别的日期），避免一开就是过去时间
  let startTime = '09:00'
  if (iso === TODAY) {
    const now = new Date()
    const nextHour = Math.min(HOUR_TO - 1, Math.max(HOUR_FROM, now.getHours() + 1))
    startTime = `${pad(nextHour)}:00`
  }
  const [y, m, d] = parts(iso)
  const start = new Date(y, m - 1, d, Number(startTime.slice(0, 2)), 0, 0, 0).getTime()
  createTitle.value = ''
  createDate.value = iso
  createTime.value = startTime
  setEndFromStart(start)
  createKey.value += 1
  createOpen.value = true
  haptic('light')
}

function onCreateStartDate(e: any): void {
  const v = pickValue(e)
  if (v !== '') createDate.value = v
  keepCreateOrder()
}

function onCreateStartTime(e: any): void {
  const v = pickValue(e)
  if (v !== '') createTime.value = v
  keepCreateOrder()
}

function onCreateEndDate(e: any): void {
  const v = pickValue(e)
  if (v !== '') createEndDate.value = v
}

function onCreateEndTime(e: any): void {
  const v = pickValue(e)
  if (v !== '') createEndTime.value = v
}

/** 表单提示：时长 + 是否跨天，保存前就知道结果长什么样。 */
const createHint = computed(() => {
  const s = createStartMs()
  const e = createEndMs()
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '时间格式不对'
  if (e <= s) return '结束要晚于开始'
  const min = Math.round((e - s) / 60_000)
  const dur = min >= 60
    ? `${Math.floor(min / 60)} 小时${min % 60 > 0 ? ` ${min % 60} 分钟` : ''}`
    : `${min} 分钟`
  return isoOf(s) === lastIso(e) ? dur : `${dur} · 跨天`
})

/**
 * 保存：先 addTask 再 scheduleTask。
 * 两步而不是一步塞 startAt/endAt 进 addTask，是为了让 date/when 由 scheduleTask 统一反推，
 * 与拖拽、改时长走同一条写入路径。
 */
function submitCreate(): void {
  const title = createTitle.value.trim()
  if (title === '') {
    toast('先写一句要办的事')
    return
  }
  const start = createStartMs()
  const end = createEndMs()
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    toast('时间格式不对')
    return
  }
  if (end <= start) {
    toast('结束要晚于开始')
    return
  }
  const iso = createDate.value
  const task = addTask(title, { date: iso, when: createTime.value })
  scheduleTask(task.id, start, end)
  createOpen.value = false
  anchor.value = iso
  flashFor(task.id, iso)
  haptic('medium')
  const min = Math.round((end - start) / 60_000)
  toast(`已建 ${md(iso)} ${hm(start)}–${hm(end)}（${durationText(min)}）`)
}

/* ── 时间线（每分钟挪一次 now line） + 提醒轮询 ─────────────────────── */

let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  timer = setInterval(() => { nowTick.value = new Date() }, 60_000)
  nextTick(() => focusSelectedDay())
  startReminderPoll()
})

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer)
  if (flashTimer !== undefined) clearTimeout(flashTimer)
  clearHold()
  detachMouse()
  stopReminderPoll()
})

onShow(() => {
  nowTick.value = new Date()
  // 从别的页面回来可能已经过了好几次 15 秒：立刻补一次，再恢复轮询
  startReminderPoll()
})

onHide(() => {
  // 页面不可见就没有"提醒"的意义：停掉轮询，回来时 onShow 再补
  stopReminderPoll()
})

/** 月 → 周时网格是新建的，滚动位置必须重新给一次。 */
watch(calView, (v) => {
  if (v === 'week') focusSelectedDay()
})
</script>

<template>
  <WorkShell active="calendar" title="日历" :sub="calView === 'week' ? '周视图 · 本地存储' : '月视图 · 本地存储'">
    <view class="cal" :class="{ moving: movingId !== '', dragging: drag !== null }">
      <!-- 移动提示条：0 高 sticky 容器 + 绝对定位，正好压在被临时隐去的工具条位置上，
           既不挤动网格，也不挡日头 / 日期格这些落点。
           挤动布局是不行的：长按之后平台还会补发一次 tap，一旦内容位移，
           那一下就会落到别的日期上（等于"刚长按就被改了期"）。 -->
      <view v-if="movingId !== ''" class="movewrap">
        <view class="movebar">
          <view class="mv-dot" />
          <text class="mv-txt">正在移动《{{ movingTitle }}》· {{ moveHint }}</text>
          <view class="mv-cancel" @tap.stop="cancelMove"><text>取消</text></view>
        </view>
      </view>

      <!-- 周 / 月切换与翻页 -->
      <view class="calbar">
        <view class="navgrp">
          <view class="nav-b" @tap="shift(-1)"><text class="nav-g">‹</text></view>
          <text class="mono wk">{{ barLabel }}</text>
          <view class="nav-b" @tap="shift(1)"><text class="nav-g">›</text></view>
        </view>
        <view class="sp" />
        <view class="today-btn" @tap="goToday"><text>今天</text></view>
        <!-- 新建：标题 + 开始/结束（日期 + 时间，结束可跨天）都在这一个表单里 -->
        <view class="new-btn" @tap="openCreate"><text>＋ 新建</text></view>
        <view class="seg">
          <view class="seg-btn" :class="{ on: calView === 'week' }" @tap="setCalView('week')"><text>周</text></view>
          <view class="seg-btn" :class="{ on: calView === 'month' }" @tap="setCalView('month')"><text>月</text></view>
        </view>
      </view>

      <!-- 周视图：7 天 × 8:00–21:00 -->
      <view v-if="calView === 'week'" class="weekwrap">
        <scroll-view scroll-x class="wk-scroll" :show-scrollbar="false" :scroll-left="weekScrollLeft">
          <view class="week-canvas">
            <view class="weekhead">
              <view class="hc-spacer" />
              <view
                v-for="d in weekDays"
                :key="d.iso"
                class="hc"
                :class="{ today: d.isToday, sel: anchor === d.iso }"
                @tap="tapDate(d.iso)"
              >
                <text class="hwd">{{ d.weekday }}</text>
                <text class="hd mono">{{ d.md }}</text>
              </view>
            </view>

            <view class="weekgrid">
              <view class="hourcol">
                <view v-for="h in HOURS" :key="h" class="hl">
                  <text class="hl-t mono">{{ pad(h) }}:00</text>
                </view>
              </view>

              <view
                v-for="d in weekDays"
                :key="d.iso"
                class="daycol"
                :class="{ today: d.isToday, drop: dragIso === d.iso }"
                @tap="tapDate(d.iso)"
              >
                <view
                  v-for="h in HOURS"
                  :key="h"
                  class="slot"
                  :class="{ drop: dragIso === d.iso && dragHour === h }"
                  @tap.stop="slotTap(d.iso, h)"
                />

                <!-- 长按 = 操作菜单；移动模式下按住 = 拖动（触摸与鼠标共用一套落点计算）。
                     主体色 = 状态色（--st），左侧 3px 细条 = 空间 / 优先级色（--ev）。 -->
                <view
                  v-for="ev in d.events"
                  :key="ev.id"
                  class="evbar"
                  :class="[ev.tone, {
                    done: ev.done,
                    cross: ev.cross,
                    moving: ev.id === movingId,
                    flash: ev.id === flashTaskId,
                    dragging: drag !== null && drag.id === ev.id,
                  }]"
                  :style="evStyle(ev)"
                  @tap.stop="openTask(ev.id)"
                  @longpress="openMenu(ev.id)"
                  @touchstart="barTouchStart(ev.id, d.iso, ev, $event)"
                  @touchmove="barTouchMove($event)"
                  @touchend="barTouchEnd($event)"
                  @touchcancel="barTouchCancel()"
                  @mousedown="barMouseDown(ev.id, d.iso, ev, $event)"
                  @mouseup="onBarRelease"
                  @mouseleave="clearHold"
                >
                  <text class="et">{{ ev.title }}</text>
                  <view class="efoot">
                    <text v-if="hasBell(ev.id)" class="bell">🔔</text>
                    <text class="eh mono">{{ ev.range }}</text>
                  </view>
                </view>

                <view v-if="d.isToday && nowY >= 0" class="nowline" :style="'top:' + nowY + 'px'" />
              </view>
            </view>
          </view>
        </scroll-view>
      </view>

      <!-- 月视图 -->
      <view v-else class="monthwrap">
        <view class="mrow">
          <text v-for="w in WEEK_LABELS" :key="w" class="mhd">{{ w }}</text>
        </view>
        <view class="monthgrid">
          <view
            v-for="c in monthCells"
            :key="c.iso"
            class="mcell"
            :class="{ out: c.out, today: c.isToday, sel: c.sel, flash: c.iso === flashIso }"
            @tap="tapMonthCell(c.iso)"
          >
            <!-- 数字 = 进那一周；格子空白 = 就地新建（移动模式下两处都是落点） -->
            <view class="mday" @tap.stop="tapMonthDay(c.iso)">
              <text class="dn mono">{{ c.d }}</text>
            </view>
            <view class="mdots">
              <view v-for="(dot, i) in c.dots" :key="i" class="mdot" :style="'background:' + dot" />
            </view>
          </view>
        </view>
        <text class="mhint">{{ movingId !== '' ? '点任意日期把任务移过去' : '点日期数字跳到那一周 · 点空白处新建' }}</text>
      </view>

      <!-- 选中日期的安排 -->
      <view class="sect">
        <text class="st">{{ agendaTitle }}</text>
        <text class="mono sn">{{ agenda.length }} 项</text>
        <view class="line" />
      </view>

      <view class="card">
        <view v-if="agenda.length === 0" class="aempty">这一天没有安排 · 在下面加一条</view>
        <view
          v-for="a in agenda"
          :key="a.id"
          class="agenda-item"
          :class="{ done: a.done }"
          @tap="openTask(a.id)"
        >
          <!-- 3px 状态色条：未开始 / 进行中 / 已完成一眼可分 -->
          <view class="bar" :style="'background:' + a.st" />
          <view class="abody">
            <text class="at mono">
              <text>{{ a.range }}</text>
              <text v-if="a.cross" class="across"> · 跨天</text>
              <text> · {{ a.dev }}</text>
            </text>
            <text class="an"><text v-if="a.bell" class="bell">🔔 </text>{{ a.title }}</text>
          </view>
          <text class="achip" :style="'color:' + a.st + ';border-color:' + a.st">{{ a.stLabel }}</text>
          <text class="ago">›</text>
        </view>

        <view class="addrow">
          <input
            :key="quickKey"
            v-model="quickTitle"
            class="ain"
            placeholder="加一条到这天…"
            placeholder-class="ph"
            :maxlength="80"
            @confirm="quickAdd"
          />
          <picker mode="time" :value="quickTime" @change="onPickTime">
            <view class="atime mono"><text>{{ quickTime }}</text></view>
          </picker>
          <view class="aadd" @tap="quickAdd"><text class="aadd-g">＋</text></view>
        </view>
      </view>

      <!-- 拖动中的幽灵条：fixed 跟手，pointer-events: none 保证它不抢落点的手势 -->
      <view v-if="drag !== null" class="ghost" :class="drag.tone" :style="ghostStyle">
        <text class="ghost-t">{{ drag.title }}</text>
        <text class="ghost-h mono">{{ dragLabel }}</text>
      </view>
    </view>

    <!-- 共用任务详情 -->
    <WorkTaskDetail :visible="detailOpen" :task-id="detailId" @close="detailOpen = false" />

    <!-- 长按操作菜单（ActionSheet 风格；「取消」是它自带的底部取消条） -->
    <MossSheet
      :visible="menuOpen"
      kind="menu"
      :title="menuTitle"
      :items="MENU_ITEMS"
      @update:visible="menuOpen = $event"
      @select="onMenuSelect"
    />

    <!-- 删除二次确认 -->
    <MossSheet
      :visible="deleteOpen"
      kind="confirm"
      title="删除这条任务？"
      :message="deleteMessage"
      confirm-text="删除"
      cancel-text="取消"
      @update:visible="deleteOpen = $event"
      @confirm="doDelete"
    />

    <!-- 二级菜单：提前量 / 时长（同一个 MossSheet，换 items） -->
    <MossSheet
      :visible="subOpen"
      kind="menu"
      :title="subTitle"
      :items="subItems"
      @update:visible="subOpen = $event"
      @select="onSubSelect"
    />

    <!-- 新建表单：MossSheet 只有 menu/confirm/prompt 三种形态，装不下 4 个 picker，
         所以这里用页内自绘弹层（同样的遮罩 + 底部升起，视觉与 MossSheet 一致）。 -->
    <view v-if="createOpen" class="fmask" @tap="createOpen = false">
      <view class="fsheet" @tap.stop>
        <view class="fgrab" />
        <text class="ftitle">新建日程</text>

        <input
          :key="createKey"
          v-model="createTitle"
          class="fin"
          placeholder="要办的事…"
          placeholder-class="ph"
          :maxlength="80"
        />

        <view class="frow">
          <text class="flabel">开始</text>
          <picker class="fpick-wrap" mode="date" :value="createDate" @change="onCreateStartDate">
            <view class="fpick mono"><text>{{ createDate }}</text></view>
          </picker>
          <picker class="fpick-wrap tight" mode="time" :value="createTime" @change="onCreateStartTime">
            <view class="fpick mono"><text>{{ createTime }}</text></view>
          </picker>
        </view>

        <view class="frow">
          <text class="flabel">结束</text>
          <picker class="fpick-wrap" mode="date" :value="createEndDate" @change="onCreateEndDate">
            <view class="fpick mono"><text>{{ createEndDate }}</text></view>
          </picker>
          <picker class="fpick-wrap tight" mode="time" :value="createEndTime" @change="onCreateEndTime">
            <view class="fpick mono"><text>{{ createEndTime }}</text></view>
          </picker>
        </view>

        <text class="fhint">{{ createHint }}</text>

        <view class="fact">
          <view class="fbtn ghost" @tap="createOpen = false"><text>取消</text></view>
          <view class="fbtn primary" @tap="submitCreate"><text>保存</text></view>
        </view>
      </view>
    </view>
  </WorkShell>
</template>

<style lang="scss" scoped>
.cal {
  display: flex;
  flex-direction: column;
  padding-top: 2px;
}

/* ── 移动提示条 ─────────────────────────────────────────────────── */

/* 0 高 sticky：提示条贴着滚动视口顶部，但完全不占页面高度（见模板注释） */
.movewrap {
  position: sticky;
  top: 0;
  z-index: 30;
  height: 0;
}

.movebar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 9px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd-strong);
  background: color-mix(in srgb, var(--acc-soft) 60%, var(--s1));
  box-shadow: 0 6px 18px var(--acc-soft);
}

/* 提示条正好顶替工具条：移动期间工具条隐去（visibility 保留占位，不产生位移） */
.cal.moving .calbar { visibility: hidden; }

.mv-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--acc);
  box-shadow: 0 0 0 3px var(--acc-soft);
}

.mv-txt {
  flex: 1;
  min-width: 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--t1);
}

.mv-cancel {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 10px;
  border-radius: 7px;
  border: 1px solid var(--bd-strong);
  background: var(--s1);
  color: var(--t1);
  display: flex;
  align-items: center;
  font-size: 10px;
}

.mv-cancel:active { color: var(--acc); }

/* ── 工具条 ─────────────────────────────────────────────────────── */

.calbar {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 2px 0 10px;
}

.navgrp {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.nav-b {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 9px;
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t2);
  display: grid;
  place-items: center;
}

.nav-b:active { color: var(--acc); border-color: var(--bd-strong); }

.nav-g {
  font-size: 16px;
  line-height: 1;
  margin-top: -2px;
}

.wk {
  font-size: 12px;
  font-weight: 600;
  color: var(--t1);
  letter-spacing: 0.01em;
  white-space: nowrap;
}

.sp { flex: 1; }

.today-btn {
  height: 28px;
  padding: 0 10px;
  border-radius: 9px;
  border: 1px solid var(--bd);
  background: var(--s1);
  color: var(--t2);
  display: flex;
  align-items: center;
  font-size: 10.5px;
}

.today-btn:active { color: var(--acc); border-color: var(--bd-strong); }

/* 新建入口：和「今天」同高，用强调色描边区分"这是写操作" */
.new-btn {
  height: 28px;
  padding: 0 10px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--acc) 55%, var(--bd));
  background: var(--acc-soft);
  color: var(--acc);
  display: flex;
  align-items: center;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}

.new-btn:active { background: color-mix(in srgb, var(--acc-soft) 70%, var(--s1)); }

.seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 10px;
  border: 1px solid var(--bd);
  background: var(--s2);
}

.seg-btn {
  width: 32px;
  height: 22px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--t3);
}

.seg-btn.on {
  background: var(--s1);
  color: var(--acc);
  box-shadow: inset 0 0 0 1px var(--bd);
}

/* ── 周视图 ─────────────────────────────────────────────────────── */

.weekwrap {
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--s1);
}

.wk-scroll { width: 100%; }

.week-canvas {
  width: 100%;
  min-width: 710px;
}

.weekhead {
  display: grid;
  grid-template-columns: 38px repeat(7, minmax(96px, 1fr));
  border-bottom: 1px solid var(--bd);
}

.hc {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 7px 2px 6px;
  border-left: 1px solid var(--bd);
}

.hc.today { background: var(--acc-soft); }
.hc.sel { box-shadow: inset 0 -2px 0 var(--acc); }

/* 横向滚动后时间轴仍要可见：否则事件块失去了"几点"的标尺 */
.hc-spacer {
  position: sticky;
  left: 0;
  z-index: 8;
  background: var(--s1);
  border-right: 1px solid var(--bd);
}

.hwd { font-size: 9px; color: var(--t3); }
.hd { font-size: 11px; font-weight: 600; color: var(--t2); }
.hc.today .hwd, .hc.today .hd { color: var(--acc); }

.weekgrid {
  display: grid;
  grid-template-columns: 38px repeat(7, minmax(96px, 1fr));
  position: relative;
}

.hourcol {
  position: sticky;
  left: 0;
  z-index: 5;
  background: var(--s1);
  border-right: 1px solid var(--bd);
}

.hl {
  height: 46px;
  position: relative;
}

.hl-t {
  position: absolute;
  top: 2px;
  right: 5px;
  font-size: 8px;
  color: var(--t3);
}

.daycol {
  position: relative;
  border-left: 1px solid var(--bd);
}

.daycol.today {
  background: color-mix(in srgb, var(--acc-soft) 55%, transparent);
}

.slot {
  height: 46px;
  border-bottom: 1px solid color-mix(in srgb, var(--bd) 55%, transparent);
}

/* 事件条：主体铺**状态色**（--st，由 evStyle 内联给出），
   空间 / 优先级色（--ev）退成左侧 3px 细条——两者不再互相盖住。 */
.evbar {
  position: absolute;
  z-index: 2;
  overflow: hidden;
  border-radius: 6px;
  border-left: 3px solid var(--ev, var(--acc));
  background: color-mix(in srgb, var(--st, var(--acc)) 18%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--st, var(--acc)) 26%, transparent);
  padding: 3px 5px;
}

.evbar.high { --ev: var(--danger); }
.evbar.normal { --ev: var(--acc); }
.evbar.low { --ev: var(--t3); }
.evbar.done { opacity: 0.55; }

/* 跨天片段：上下留虚线，提示"这段在当天只是被切开的一截" */
.evbar.cross {
  border-top: 1px dashed color-mix(in srgb, var(--st, var(--acc)) 60%, transparent);
  border-bottom: 1px dashed color-mix(in srgb, var(--st, var(--acc)) 60%, transparent);
  padding-top: 2px;
  padding-bottom: 2px;
}

/* 正在被移动的那条：虚线边 + 抬起，和普通任务条区分开 */
.evbar.moving {
  z-index: 4;
  border-left-style: dashed;
  opacity: 0.95;
  box-shadow: 0 0 0 1.5px var(--acc), 0 6px 14px var(--acc-soft);
}

/* 拖动中的原位残留：幽灵条在手上，原位只留一个淡淡的印子 */
.evbar.dragging {
  opacity: 0.22;
  box-shadow: none;
}

/* 刚新建 / 刚搬过来的那条：闪两下，告诉用户"就在这儿" */
.evbar.flash { animation: ev-flash 700ms var(--ease-out) 2; }

@keyframes ev-flash {
  0%, 100% { box-shadow: 0 0 0 0 var(--acc-soft); }
  50% { box-shadow: 0 0 0 4px var(--acc-glow); }
}

.et {
  display: block;
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--t1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 事件条底部一行：🔔 提醒标记 + 时段 / 跨天文案 */
.efoot {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 1px;
  min-width: 0;
}

.bell { font-size: 8px; line-height: 1; opacity: 0.9; }

.eh {
  display: block;
  min-width: 0;
  font-size: 8px;
  color: var(--t2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nowline {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 3;
  height: 1.5px;
  background: var(--danger);
  opacity: 0.8;
}

.nowline::before {
  content: '';
  position: absolute;
  left: 2px;
  top: -2.5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--danger);
}

/* ── 月视图 ─────────────────────────────────────────────────────── */

.monthwrap {
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  background: var(--s1);
  padding: 8px 8px 10px;
}

.mrow {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 5px;
}

.mhd {
  text-align: center;
  font-size: 9px;
  color: var(--t3);
  padding: 2px 0 6px;
}

.monthgrid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 5px;
}

.mcell {
  min-height: 42px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 0 4px;
  border-radius: var(--r-sm);
  border: 1px solid var(--bd);
  background: var(--s2);
}

.mcell:active { background: var(--s3); }
.mcell.out { opacity: 0.32; }
.mcell.today { border-color: var(--bd-strong); background: var(--acc-soft); }
.mcell.sel { box-shadow: inset 0 0 0 1.5px var(--acc); }

/* 日期数字是"进那一周"的入口；格子其余空白留给新建 */
.mday {
  align-self: stretch;
  display: flex;
  justify-content: center;
  padding: 1px 0 2px;
}

.mcell.flash { animation: cell-flash 700ms var(--ease-out) 2; }

@keyframes cell-flash {
  0%, 100% { box-shadow: inset 0 0 0 0 var(--acc-soft); }
  50% { box-shadow: inset 0 0 0 2px var(--acc); }
}

.dn { font-size: 10px; color: var(--t2); }
.mcell.today .dn { color: var(--acc); font-weight: 700; }

.mdots {
  display: flex;
  gap: 3px;
  min-height: 4px;
}

/* 月视图小圆点：颜色由内联 style 给（状态色），这里只留形状 */
.mdot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--acc);
}

.mhint {
  display: block;
  text-align: center;
  font-size: 9px;
  color: var(--t3);
  margin-top: 8px;
}

/* ── 移动模式：网格轻量高亮，提示"这里可以落" ───────────────────── */

.cal.moving .weekwrap,
.cal.moving .monthwrap {
  border-color: var(--bd-strong);
  box-shadow: 0 0 0 1px var(--acc-soft), inset 0 0 26px var(--acc-soft);
}

.cal.moving .hc,
.cal.moving .daycol {
  background: color-mix(in srgb, var(--acc-soft) 45%, transparent);
}

.cal.moving .hc.today,
.cal.moving .daycol.today {
  background: color-mix(in srgb, var(--acc-soft) 85%, transparent);
}

.cal.moving .hc,
.cal.moving .daycol,
.cal.moving .mcell {
  cursor: pointer;
}

.cal.moving .mcell { border-color: var(--bd-strong); }

.cal.moving .slot:active,
.cal.moving .mcell:active { background: var(--s3); }

/* 拖动时的落点：整列提亮 + 目标小时格描边，松手就落在这里 */
.cal.moving .daycol.drop {
  background: color-mix(in srgb, var(--acc-soft) 80%, transparent);
}

.slot.drop {
  background: color-mix(in srgb, var(--acc) 20%, transparent);
  box-shadow: inset 0 0 0 1px var(--acc);
}

/* 移动模式按住就能拖；拖动中禁止选中文字，否则桌面端会拖出一片蓝 */
.cal.moving .evbar {
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
}

.cal.dragging .evbar { cursor: grabbing; }
.cal.dragging { user-select: none; -webkit-user-select: none; }

/* ── 拖动幽灵条（fixed 跟手） ───────────────────────────────────── */

.ghost {
  position: fixed;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 3px 6px;
  border-radius: 6px;
  border-left: 3px solid var(--ev, var(--acc));
  background: color-mix(in srgb, var(--st, var(--ev, var(--acc))) 26%, var(--s1));
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.42), 0 0 0 1.5px var(--acc);
  overflow: hidden;
  pointer-events: none;
  opacity: 0.96;
}

.ghost.high { --ev: var(--danger); }
.ghost.normal { --ev: var(--acc); }
.ghost.low { --ev: var(--t3); }

.ghost-t {
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--t1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ghost-h {
  font-size: 8px;
  color: var(--t2);
  white-space: nowrap;
  overflow: hidden;
}

/* ── 安排列表 ───────────────────────────────────────────────────── */

.sect {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 16px 2px 8px;
}

.st {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--t3);
  text-transform: uppercase;
}

.sn { font-size: 9px; color: var(--t3); }
.line { flex: 1; height: 1px; background: var(--bd); }

.card {
  border: 1px solid var(--bd);
  border-radius: var(--r-lg);
  background: var(--s1);
  padding: 2px 12px 10px;
}

.agenda-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 0;
}

.agenda-item:active { background: var(--s2); }
.agenda-item.done { opacity: 0.6; }
.agenda-item + .agenda-item { border-top: 1px solid var(--bd); }

/* 3px 色条：颜色由内联 style 给（状态色），这里只留形状 */
.bar {
  width: 3px;
  flex: 0 0 3px;
  align-self: stretch;
  border-radius: 3px;
  background: var(--st, var(--acc));
}

.abody { flex: 1; min-width: 0; }

.at {
  display: block;
  font-size: 9px;
  color: var(--t3);
}

.across { color: var(--st-doing); }

/* 状态文案：与色条同色，边框弱化，不抢标题 */
.achip {
  align-self: center;
  flex: 0 0 auto;
  padding: 1px 5px;
  border-radius: 6px;
  border: 1px solid currentColor;
  font-size: 8.5px;
  line-height: 1.5;
  opacity: 0.9;
}

.an {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--t1);
}

.agenda-item.done .an {
  color: var(--t3);
  text-decoration: line-through;
}

.ago {
  align-self: center;
  font-size: 15px;
  color: var(--t3);
}

.aempty {
  padding: 16px 4px;
  text-align: center;
  font-size: 10px;
  color: var(--t3);
}

.addrow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 10px;
  margin-top: 2px;
  border-top: 1px solid var(--bd);
}

.ain {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 9px;
  border-radius: var(--r-sm);
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t1);
  font-size: 11px;
}

.atime {
  height: 32px;
  padding: 0 8px;
  border-radius: var(--r-sm);
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t2);
  display: flex;
  align-items: center;
  font-size: 9.5px;
}

.aadd {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: var(--r-sm);
  background: var(--acc);
  color: var(--acc-ink);
  display: grid;
  place-items: center;
}

.aadd:active { transform: scale(0.94); }
.aadd-g { font-size: 15px; font-weight: 600; line-height: 1; }

.ph { color: var(--t3); }

/* ── 新建表单（页内弹层：遮罩 + 底部升起，与 MossSheet 同一套观感） ── */

.fmask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: flex-end;
}

.fsheet {
  width: 100%;
  max-width: 520px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--bg);
  border-top: 1px solid var(--bd-strong);
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  padding: 8px 16px calc(14px + var(--safe-bottom-real, 0px));
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.5);
  animation: sheet-up var(--t-mid) var(--ease-out);
}

@keyframes sheet-up {
  from { transform: translateY(18px); opacity: 0.6; }
  to { transform: translateY(0); opacity: 1; }
}

.fgrab {
  width: 34px;
  height: 3px;
  border-radius: 2px;
  background: var(--bd-strong);
  margin: 2px auto 0;
}

.ftitle {
  font-size: 14px;
  font-weight: 600;
  color: var(--t1);
}

.fin {
  height: 40px;
  padding: 0 11px;
  border-radius: var(--r-sm);
  border: 1px solid var(--bd);
  background: var(--s1);
  color: var(--t1);
  font-size: 13px;
}

.frow {
  display: flex;
  align-items: center;
  gap: 6px;
}

.flabel {
  flex: 0 0 26px;
  font-size: 10px;
  color: var(--t3);
}

/* 日期 / 时间选择器：日期铺开、时间定宽。
   picker 在 H5 是 <uni-picker>，tag 选择器命中不了，所以用 class（挂在组件根上）。 */
.fpick-wrap { flex: 1; min-width: 0; }
.fpick-wrap.tight { flex: 0 0 auto; }

.fpick {
  height: 34px;
  min-width: 34px;
  padding: 0 9px;
  border-radius: var(--r-sm);
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t1);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}

.fpick:active { border-color: var(--bd-strong); }

.fhint {
  font-size: 9.5px;
  color: var(--t3);
  padding-left: 26px;
}

.fact {
  display: flex;
  gap: 10px;
  padding-top: 2px;
}

.fbtn {
  flex: 1;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
}

.fbtn.ghost {
  border: 1px solid var(--bd);
  background: var(--s1);
  color: var(--t2);
}

.fbtn.primary {
  background: var(--acc);
  color: var(--acc-ink);
}

.fbtn.primary:active { transform: scale(0.98); }

/* 减少动效偏好 */
@media (prefers-reduced-motion: reduce) {
  .fsheet { animation: none; }
}

/* ── 平板 ───────────────────────────────────────────────────────── */

@media (min-width: 820px) {
  .calbar { padding-bottom: 12px; }
  .wk { font-size: 13px; }
  .mcell { min-height: 52px; }
  .dn { font-size: 11px; }
  .hwd { font-size: 9.5px; }
  .hd { font-size: 12px; }
}
</style>
