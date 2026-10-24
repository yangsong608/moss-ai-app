<script setup lang="ts">
/**
 * 日历（周 / 月）。
 *
 * 周视图是主视图：7 天 × 8:00–21:00 网格，任务按 `date + when(时:分)` 落成色块；
 * 月视图用来"找密度"——点某天直接跳回那一周。下方永远跟着选中日期的安排列表，
 * 加一条也在这里（时间选择器决定它会不会出现在网格里）。
 *
 * 数据只读 @/core/workbench 的 DomainData；改期 / 改状态在共用详情抽屉里完成。
 *
 * 手势（P0-4）：
 *   1. 长按任务条 → 弹出操作菜单（移动 / 改期 · 编辑 · 删除 · 取消）。
 *      菜单用共用 MossSheet（页内自绘），不用 uni.showActionSheet：
 *      原生弹层与应用视觉两张皮，且部分平台最多只显示 6 项。
 *   2. 选「移动 / 改期」进入移动模式：
 *      - 拖动：按住色块随手指走，一个 fixed 幽灵条跟手，落点按列宽 / 行高算，
 *        松手 `updateTask(id, { date, when })`（when 取整点）。
 *      - 兜底：点日期格 / 日头只改 `date`（时间原样），桌面鼠标也能验收。
 *   3. 删除：二次确认后 `removeTask`，网格与安排列表即时消失。
 *
 * 坐标只用来"猜落点"：列宽从 createSelectorQuery 量（滚动不影响宽度），
 * 高度用与 CSS 严格一致的 HOUR_H 等分；两者都失败时退回点格子，不会写错日期。
 */
import { computed, getCurrentInstance, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import WorkShell from '@/components/WorkShell.vue'
import WorkTaskDetail from '@/components/WorkTaskDetail.vue'
import MossSheet, { type SheetItem } from '@/components/MossSheet.vue'
import {
  WEEKDAYS,
  addTask,
  isoDay,
  removeTask,
  updateTask,
  useWork,
  work,
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

/** "9:30" → 9.5；不是时间型 when（今天 / 未排期 / 截止周五）返回 null。 */
function startOf(when: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(when.trim())
  if (m === null) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null
  return h + mi / 60
}

function fmtH(x: number): string {
  const total = Math.round(x * 60)
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

function toneOf(t: Task): Tone {
  if (t.pri === 'high') return 'high'
  if (t.pri === 'low') return 'low'
  return 'normal'
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

/** 菜单项固定四项；「取消」由 MossSheet 底部取消条提供，不占选项位。 */
const MENU_ITEMS: readonly SheetItem[] = [
  { label: '移动 / 改期', hint: '进入移动模式：按住色块拖到别的日 / 时，或点日期格落下' },
  { label: '编辑', hint: '打开任务详情，改标题、备注、状态与优先级' },
  { label: '删除', hint: '从日历与安排列表移除，同步到其它端（不可恢复）', danger: true },
]

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

const tasksByDate = computed<Record<string, Task[]>>(() => {
  const map: Record<string, Task[]> = {}
  for (const t of data.value.tasks) {
    if (t.date === '') continue
    const list = map[t.date] ?? (map[t.date] = [])
    list.push(t)
  }
  return map
})

interface RawItem {
  t: Task
  start: number
  end: number
}

interface CalEvent {
  id: string
  title: string
  top: number
  height: number
  leftPct: number
  widthPct: number
  tone: Tone
  done: boolean
  range: string
}

/**
 * 一周里同一天可能撞时间：用"轨道"算法排成并排。
 * 不做这一步的话，两条 9:30 会完全重叠，用户只能看到一条。
 */
const eventsByDate = computed<Record<string, CalEvent[]>>(() => {
  const out: Record<string, CalEvent[]> = {}

  for (const date of Object.keys(tasksByDate.value)) {
    const raw: RawItem[] = []
    for (const t of tasksByDate.value[date] ?? []) {
      const s = startOf(t.when)
      if (s === null || s < HOUR_FROM || s >= HOUR_TO) continue
      raw.push({ t, start: s, end: Math.min(s + 1, HOUR_TO) })
    }
    raw.sort((a, b) => a.start - b.start)

    const list: CalEvent[] = []
    let cluster: RawItem[] = []
    let clusterEnd = -1

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
        list.push({
          id: p.item.t.id,
          title: p.item.t.title,
          top: Math.round((p.item.start - HOUR_FROM) * HOUR_H),
          height: Math.max(20, Math.round((p.item.end - p.item.start) * HOUR_H) - 4),
          leftPct: 2 + p.lane * width,
          widthPct: width - 2,
          tone: toneOf(p.item.t),
          done: p.item.t.done,
          range: `${fmtH(p.item.start)}–${fmtH(p.item.end)}`,
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

    out[date] = list
  }

  return out
})

const weekStart = computed(() => weekStartOf(anchor.value))

interface WeekDay {
  iso: string
  weekday: string
  md: string
  isToday: boolean
  events: CalEvent[]
}

const weekDays = computed<WeekDay[]>(() => {
  const start = weekStart.value
  return Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(start, i)
    const [, m, d] = parts(iso)
    return {
      iso,
      weekday: weekdayOf(iso),
      md: `${m}/${d}`,
      isToday: iso === TODAY,
      events: eventsByDate.value[iso] ?? [],
    }
  })
})

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
  dots: Tone[]
}

const monthCells = computed<MonthCell[]>(() => {
  const [y, m] = parts(anchor.value)
  const first = new Date(y, m - 1, 1)
  const lead = (first.getDay() + 6) % 7
  const start = isoDay(new Date(y, m - 1, 1 - lead))
  return Array.from({ length: 42 }, (_, i) => {
    const iso = addDays(start, i)
    const [yy, mm, dd] = parts(iso)
    const tasks = tasksByDate.value[iso] ?? []
    return {
      iso,
      d: dd,
      out: yy !== y || mm !== m,
      isToday: iso === TODAY,
      sel: iso === anchor.value,
      dots: tasks.slice(0, 3).map((t) => toneOf(t)),
    }
  })
})

interface AgendaItem {
  id: string
  title: string
  range: string
  dev: string
  tone: Tone
  done: boolean
}

const agenda = computed<AgendaItem[]>(() => {
  // 历史遗留的"已完成但没时间"的任务不该占安排列表：它没有时段，也不会出现在网格里。
  const list = (tasksByDate.value[anchor.value] ?? []).filter(
    (t) => !(t.done && startOf(t.when) === null),
  )
  const rank = (t: Task): number => startOf(t.when) ?? 99
  return list
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map((t) => {
      const s = startOf(t.when)
      return {
        id: t.id,
        title: t.title,
        tone: toneOf(t),
        done: t.done,
        dev: t.dev,
        range: s === null ? '未定时' : `${fmtH(s)}–${fmtH(Math.min(s + 1, HOUR_TO))}`,
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
  menuOpen.value = false
  menuId.value = ''
  if (id === '') return
  if (data.value.tasks.find((t) => t.id === id) === undefined) {
    toast('这条任务已经不在了')
    return
  }
  if (index === 0) {
    startMove(id)
    return
  }
  if (index === 1) {
    openDetail(id)
    return
  }
  if (index === 2) askDelete(id)
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
  targetHour: number
  moved: boolean
  pointer: 'touch' | 'mouse'
}

const drag = ref<DragState | null>(null)
/** 手指移动超过这个距离才算"拖动"，否则还是当作一次点击。 */
const DRAG_SLOP = 6
/** 实测列宽（px）。滚动不影响宽度，所以只量一次就够。 */
let colWidth = 96
let measuring = false

const dragIso = computed(() => (drag.value === null || !drag.value.moved ? '' : drag.value.targetIso))
const dragHour = computed(() => (drag.value === null || !drag.value.moved ? -1 : drag.value.targetHour))

const dragLabel = computed(() => {
  const d = drag.value
  if (d === null) return ''
  return `${md(d.targetIso)} ${pad(d.targetHour)}:00`
})

/** 提示条上的一句话：拖动中报落点，未拖时报"还能怎么落"。 */
const moveHint = computed(() => {
  const d = drag.value
  if (d !== null && d.moved) return `松手落到 ${md(d.targetIso)} ${pad(d.targetHour)}:00`
  return calView.value === 'week'
    ? '按住色块拖动 · 或点日期格 / 日头落下'
    : '点任意日期把任务移过去'
})

const ghostStyle = computed(() => {
  const d = drag.value
  if (d === null) return ''
  return `left:${Math.round(d.x)}px;top:${Math.round(d.y)}px;width:${d.width}px;height:${d.height}px`
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

function startDrag(id: string, iso: string, ev: CalEvent, x: number, y: number, pointer: 'touch' | 'mouse'): void {
  if (movingId.value !== id) return
  const startCol = weekDays.value.findIndex((d) => d.iso === iso)
  if (startCol < 0) return
  const width = Math.max(64, Math.round(colWidth - 6))
  const height = Math.max(26, ev.height)
  // 抓取点固定在手指下方一点点：幽灵条不会整块跳到指尖，也不会遮住落点
  const grab = Math.min(height - 6, Math.max(10, Math.round(height / 2)))
  drag.value = {
    id,
    title: ev.title,
    tone: ev.tone,
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
    targetHour: clampInt(HOUR_FROM + Math.floor(ev.top / HOUR_H), HOUR_FROM, HOUR_TO - 1),
    moved: false,
    pointer,
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
  // 小时：起点色块 top + 竖向位移，落在第几个 46px 格子里就是几点
  const hour = clampInt(HOUR_FROM + Math.floor((d.baseTop + dy) / HOUR_H), HOUR_FROM, HOUR_TO - 1)
  d.targetIso = iso
  d.targetHour = hour
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
  const when = `${pad(d.targetHour)}:00`
  const iso = d.targetIso
  movingId.value = ''
  swallowTap(d.id, 600)
  if (task.date === iso && task.when === when) {
    toast('位置没变')
    return
  }
  updateTask(d.id, { date: iso, when })
  flashFor(d.id, iso)
  // 周视图把选中日跟过去：任务同时出现在下方安排列表里，改期结果一眼可见
  anchor.value = iso
  haptic('light')
  toast(`已移到 ${md(iso)} · ${when}`)
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
    startDrag(id, iso, ev, p.x, p.y, 'touch')
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
    startDrag(id, iso, ev, p.x, p.y, 'mouse')
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
  const when = task.when
  updateTask(id, { date: iso })
  flashFor(id, iso)
  // 周视图里把选中日跟过去，任务同时出现在下方安排列表里，改期结果一眼可见
  if (calView.value === 'week') anchor.value = iso
  haptic('light')
  toast(startOf(when) === null ? `已移到 ${md(iso)}` : `已移到 ${md(iso)} · ${when}`)
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

function evStyle(e: CalEvent): string {
  return `top:${e.top}px;height:${e.height}px;left:${e.leftPct}%;width:${e.widthPct}%`
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

/* ── 时间线（每分钟挪一次 now line） ───────────────────────────────── */

let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  timer = setInterval(() => { nowTick.value = new Date() }, 60_000)
  nextTick(() => focusSelectedDay())
})

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer)
  if (flashTimer !== undefined) clearTimeout(flashTimer)
  clearHold()
  detachMouse()
})

onShow(() => {
  nowTick.value = new Date()
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

                <!-- 长按 = 操作菜单；移动模式下按住 = 拖动（触摸与鼠标共用一套落点计算） -->
                <view
                  v-for="ev in d.events"
                  :key="ev.id"
                  class="evbar"
                  :class="[ev.tone, {
                    done: ev.done,
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
                  <text class="eh mono">{{ ev.range }}</text>
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
              <view v-for="(tone, i) in c.dots" :key="i" class="mdot" :class="tone" />
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
          <view class="bar" :class="a.tone" />
          <view class="abody">
            <text class="at mono">{{ a.range }} · {{ a.dev }}</text>
            <text class="an">{{ a.title }}</text>
          </view>
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

.evbar {
  position: absolute;
  z-index: 2;
  overflow: hidden;
  border-radius: 6px;
  border-left: 2px solid var(--ev, var(--acc));
  background: color-mix(in srgb, var(--ev, var(--acc)) 16%, transparent);
  padding: 3px 5px;
}

.evbar.high { --ev: var(--danger); }
.evbar.normal { --ev: var(--acc); }
.evbar.low { --ev: var(--t3); }
.evbar.done { opacity: 0.55; }

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

.eh {
  display: block;
  margin-top: 1px;
  font-size: 8px;
  color: var(--t2);
  white-space: nowrap;
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

.mdot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--acc);
}

.mdot.high { background: var(--danger); }
.mdot.low { background: var(--t3); }

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
  background: color-mix(in srgb, var(--ev, var(--acc)) 24%, var(--s1));
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

.bar {
  width: 3px;
  flex: 0 0 3px;
  align-self: stretch;
  border-radius: 3px;
  background: var(--ev, var(--acc));
}

.bar.high { --ev: var(--danger); }
.bar.normal { --ev: var(--acc); }
.bar.low { --ev: var(--t3); }

.abody { flex: 1; min-width: 0; }

.at {
  display: block;
  font-size: 9px;
  color: var(--t3);
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
