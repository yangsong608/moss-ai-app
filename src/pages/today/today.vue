<script setup lang="ts">
/**
 * 今天（默认屏）。
 *
 * 一屏回答三件事：现在什么进度（大日期 + 环形进度）、今天还有什么（清单 / 看板 / 历史）、
 * 顺手记一件（快速记录，回车连建、不打断输入）。
 *
 * 数据全部来自 @/core/workbench；本页只做投影和写动作，不自己存状态。
 * 环形进度点击 = 清已完成（必须二次确认，删除是不可逆的）。
 * 任务行长按（或点右侧 ⋯）= 编辑 / 删除；历史视图里的完成记录可恢复或删除。
 */
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import WorkShell from '@/components/WorkShell.vue'
import WorkTaskDetail from '@/components/WorkTaskDetail.vue'
import {
  STATUS_META,
  WEEKDAYS,
  addTask,
  clearDone,
  deviceName,
  domainStats,
  historyTasks,
  isoDay,
  removeTask,
  switchDevice,
  taskSpan,
  tasksOnDay,
  toggleTask,
  updateTask,
  useWork,
  work,
  workDevices,
  type Task,
  type TaskGroup,
  type TaskStatus,
} from '@/core/workbench'
import { haptic } from '@/core/haptic'
import { state } from '@/core/store'

const { data } = useWork()

/* 先播放短暂的本地反馈，再调用原有数据动作；集合变化不影响任务数据源。 */
const enteringIds = ref<Set<string>>(new Set())
const completingIds = ref<Set<string>>(new Set())
const leavingIds = ref<Set<string>>(new Set())
const feedbackTimers = new Set<ReturnType<typeof setTimeout>>()

function markFeedback(target: typeof enteringIds, id: string): void {
  const next = new Set(target.value)
  next.add(id)
  target.value = next
}

function afterFeedback(callback: () => void, ms: number): void {
  if (stateLiteOrReduced()) {
    callback()
    return
  }
  const timer = setTimeout(() => {
    feedbackTimers.delete(timer)
    callback()
  }, ms)
  feedbackTimers.add(timer)
}

function stateLiteOrReduced(): boolean {
  if (typeof window === 'undefined') return false
  return state.lite || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function staggerClass(index: number): string {
  return index < 8 ? `fb-stagger fb-i-${index}` : ''
}

function taskFeedbackClass(t: Task, index: number, doneGroup = false): (string | Record<string, boolean>)[] {
  return [
    !doneGroup && !t.done && !enteringIds.value.has(t.id) ? staggerClass(index) : '',
    {
      'fb-enter': enteringIds.value.has(t.id),
      'fb-exit': leavingIds.value.has(t.id) || completingIds.value.has(t.id),
    },
  ]
}

onUnmounted(() => {
  feedbackTimers.forEach((timer) => clearTimeout(timer))
  feedbackTimers.clear()
})

const pad2 = (n: number): string => String(n).padStart(2, '0')

/* ── 实时时钟 ────────────────────────────────────────────────────── */

/**
 * 页面时钟：每秒用 `new Date()` 重新取系统时间再格式化，不做毫秒累加。
 * 设备休眠 / 主线程卡顿后回到前台也不会漂移；`todayIso` 由它派生，
 * 跨午夜时日期、星期与「今天」分组会一起翻篇。
 */
const now = ref(new Date())

const clock = computed(() => {
  const d = now.value
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
})

const todayIso = computed(() => isoDay(now.value))
const weekday = computed(() => WEEKDAYS[now.value.getDay()])
const monthDay = computed(() => `${now.value.getMonth() + 1}月${now.value.getDate()}日`)

/** 周一为一周起点（与日历页一致），历史分组的「本周」按它切。 */
function weekStartOf(iso: string): string {
  const p = iso.split('-')
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
  const dow = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dow)
  return isoDay(d)
}

const weekStart = computed(() => weekStartOf(todayIso.value))

let clockTimer: ReturnType<typeof setInterval> | undefined

/** 只重新采样系统时间；格式化全部交给 computed（每秒都是真时间） */
function tickClock(): void {
  now.value = new Date()
}

function startClock(): void {
  stopClock()
  tickClock()
  clockTimer = setInterval(tickClock, 1000)
}

/** onHide / onUnmounted 都要清：后台不空转，避免无谓耗电 */
function stopClock(): void {
  if (clockTimer !== undefined) {
    clearInterval(clockTimer)
    clockTimer = undefined
  }
}

onShow(() => { startClock() })
onHide(() => { stopClock() })
onUnmounted(() => { stopClock() })

/* ── 指标与当日聚合 ──────────────────────────────────────────────── */

/** 与日历同一口径：某天覆盖到的任务（含跨天任务落在这天的部分） */
const todayItems = computed(() => tasksOnDay(data.value.tasks, todayIso.value).filter((t) => !t.done))

/** 环形进度与指标都按当前设备域的全量任务算（与 domainStats 口径一致）。 */
const stats = computed(() => domainStats(data.value))
const doneToday = computed(() => data.value.tasks.filter((t) => t.done && t.date === todayIso.value).length)
const pendingFocus = computed(() => todayItems.value.filter((t) => t.status !== 'waiting').length)
const highPri = computed(() => todayItems.value.filter((t) => t.pri === 'high').length)
const pendingSync = computed(() => data.value.tasks.filter((t) => t.sync && !t.done).length)
// 设备域列表由 WorkShell / workbench 统一提供（配对后是真实宿主，未配对时退回演示域）
const onlineDevices = computed(() => workDevices.value.filter((d) => d.online).length)
const sub = computed(() => `${weekday.value} · 今日 ${todayItems.value.length} 项`)

const ringStyle = computed(() => {
  const pct = stats.value.pct
  return { background: `conic-gradient(var(--acc) 0 ${pct}%, var(--s3) ${pct}% 100%)` }
})

function toast(title: string): void {
  uni.showToast({ title, icon: 'none' })
}

/* ── 快速记录（回车连建） ───────────────────────────────────────────── */

const quick = ref('')
const quickDev = ref(work.deviceId)
const inputFocus = ref(false)
/**
 * 快速输入框的重建计数。
 *
 * 只在 @confirm 里把 quick 置空并不总能清掉输入框：最后一击的 input 事件可能晚于
 * confirm 到达，把旧文本又写回 DOM（实测按得越快越容易复现）。换 key 重建一次
 * 输入框是唯一与框架更新顺序无关的做法，代价只有一次重挂载。
 */
const quickKey = ref(0)

const quickDevName = computed(
  () => workDevices.value.find((d) => d.id === quickDev.value)?.name ?? deviceName(),
)

/** 设备域切换后，快速记录跟随当前域；详情抽屉也要收起（可能跨域找不到任务）。 */
watch(
  () => work.deviceId,
  (id) => {
    quickDev.value = id
    detailOpen.value = false
  },
)

/** 配对 / 解绑后域列表会变：旧目标可能已经不存在，回收当前域。 */
watch(
  () => workDevices.value.map((d) => d.id).join(','),
  () => {
    if (!workDevices.value.some((d) => d.id === quickDev.value)) quickDev.value = work.deviceId
  },
)

function cycleQuickDev(): void {
  const list = workDevices.value
  const idx = list.findIndex((d) => d.id === quickDev.value)
  const next = list[(idx + 1) % list.length]!
  quickDev.value = next.id
  haptic('light')
  toast(next.id === work.deviceId ? `快速记录 → ${next.name}` : `快速记录 → ${next.name}（保存时切域）`)
}

/** 保存后重新聚焦：手机键盘不该在每次回车后收起一次。 */
function keepFocus(): void {
  inputFocus.value = false
  setTimeout(() => { inputFocus.value = true }, 30)
}

function addQuick(e?: any): void {
  // @confirm 的 detail.value 比 v-model 更接近真实输入（避免最后一个字被吃掉）
  const raw = e?.detail?.value
  const title = String(typeof raw === 'string' ? raw : quick.value).trim()
  if (title === '') {
    toast('先写一句要记的事')
    return
  }
  // 目标设备不是当前域时先切域，任务才会落进那台设备的数据里
  if (quickDev.value !== work.deviceId) switchDevice(quickDev.value)
  const task = addTask(title, { date: todayIso.value, when: '今天', dev: deviceName() })
  markFeedback(enteringIds, task.id)
  quick.value = ''
  quickKey.value += 1
  haptic('light')
  toast(`已记下 · ${deviceName()}`)
  keepFocus()
}

/* ── 清单 / 看板 / 历史 / 筛选 ─────────────────────────────────────── */

type TaskView = 'list' | 'board'
const taskView = ref<TaskView>('list')

type FilterMode = 'all' | 'high' | 'sub'
const filterMode = ref<FilterMode>('all')
const FILTER_LABEL: Record<FilterMode, string> = { all: '筛选', high: '高优先', sub: '有子待办' }


const filtered = computed(() => {
  const list = data.value.tasks
  if (filterMode.value === 'high') return list.filter((t) => t.pri === 'high')
  if (filterMode.value === 'sub') return list.filter((t) => t.sub.length > 0)
  return list
})

interface GroupView {
  key: TaskGroup
  label: string
  icon: string
  items: Task[]
  hint: string
}

const groups = computed<GroupView[]>(() => {
  const list = filtered.value
  // 「今天」= 日历口径的当日聚合：跨天任务落在今天的那一段也在这组
  const todays = tasksOnDay(list, todayIso.value).filter((t) => !t.done)
  const todaySet = new Set(todays.map((t) => t.id))
  const rest = list.filter((t) => !t.done && !todaySet.has(t.id))
  return [
    { key: 'today', label: '今天', icon: '✓', items: todays, hint: '今天还没有安排 · 用上面输入框记一件' },
    { key: 'scheduled', label: '之后安排', icon: '▦', items: rest.filter((t) => t.date !== ''), hint: '没有排到其他日期的任务' },
    { key: 'inbox', label: '未排期', icon: '▤', items: rest.filter((t) => t.date === ''), hint: '收件箱是空的' },
  ]
})

/** 空分组默认不占屏幕；只有「今天」空着时保留，用来提示去记录。 */
const visibleGroups = computed(() => groups.value.filter((g) => g.items.length > 0 || g.key === 'today'))

/* ── 状态色 / 跨天区间 ────────────────────────────────────────────── */

/** 任务当前状态：完成优先，其余 next/doing 都算进行中，waiting 是未开始。 */
function statusKeyOf(t: Task): 'waiting' | 'doing' | 'done' {
  if (t.done) return 'done'
  return t.status === 'waiting' ? 'waiting' : 'doing'
}

function statusVar(t: Task): string {
  return STATUS_META[statusKeyOf(t)].cssVar
}

function statusLabel(t: Task): string {
  return STATUS_META[statusKeyOf(t)].label
}

/** 状态色条（3px）与状态文案的取色，全部走主题令牌，不用 --acc。 */
function statusStyle(t: Task): { background: string } {
  return { background: `var(${statusVar(t)})` }
}

function statusChipStyle(t: Task): { color: string } {
  return { color: `var(${statusVar(t)})` }
}

const DAY_MS = 86_400_000

/** 区间端点：`M/D HH:MM`，两端同格式，一眼看出跨到哪一天 */
function mdhm(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * 跨天区间的展示文案，如 `10/24 22:00 → 10/25 07:00`。
 * 全天任务的 end 落在次日 0 点，是日历占位而不是时段：不显示 `00:00 → 00:00`。
 */
function spanLabel(t: Task): string {
  const span = taskSpan(t)
  if (span === undefined) return ''
  if (isoDay(new Date(span.start)) === isoDay(new Date(span.end))) return ''
  // 没有绝对区间的「全天」任务：end 只是次日 0 点的日历占位，不是时段，不显示 00:00 → 00:00
  const explicit = typeof t.startAt === 'number' && typeof t.endAt === 'number'
  if (!explicit && span.end - span.start >= DAY_MS) return ''
  return `${mdhm(span.start)} → ${mdhm(span.end)}`
}

function isCrossDay(t: Task): boolean {
  return spanLabel(t) !== ''
}

interface BoardCol {
  key: TaskStatus
  label: string
  items: Task[]
}

const board = computed<BoardCol[]>(() => {
  const live = filtered.value.filter((t) => !t.done)
  return [
    { key: 'next', label: '下一步', items: live.filter((t) => t.status === 'next') },
    { key: 'doing', label: '进行中', items: live.filter((t) => t.status === 'doing') },
    { key: 'waiting', label: '等待中', items: live.filter((t) => t.status === 'waiting') },
  ]
})

interface HistoryGroupView {
  key: 'today' | 'week' | 'earlier'
  label: string
  icon: string
  items: Task[]
  hint: string
}

/** 完成时间按本地时区折算成 ISO 日期，跨天判断不受 UTC 偏移影响。 */
function completedIso(t: Task): string {
  return isoDay(new Date(t.updatedAt))
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 历史行的完成时间：今天 / 本周带星期 / 更早带月日。 */
function completedLabel(t: Task): string {
  const day = completedIso(t)
  if (day === todayIso.value) return `今天 ${hhmm(t.updatedAt)}`
  const d = new Date(t.updatedAt)
  if (day >= weekStart.value) return `${WEEKDAYS[d.getDay()]} ${hhmm(t.updatedAt)}`
  const year = d.getFullYear() === now.value.getFullYear() ? '' : `${d.getFullYear()}年`
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(t.updatedAt)}`
}

/* ── 今天的翻页卡片：只当日、按时间排序 ─────────────────────────────── */

const WEEK_TXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const todayMD = computed(() => {
  const d = new Date(`${todayIso.value}T00:00:00`)
  return {
    month: `${d.getMonth() + 1}月`,
    day: String(d.getDate()).padStart(2, '0'),
    week: WEEK_TXT[d.getDay()] ?? '',
  }
})

/** 只看今天：日历口径的当日集合，去掉已完成，按开始时间升序（无时间的排最后） */
const todayCards = computed<Task[]>(() => {
  const onDay = tasksOnDay(filtered.value, todayIso.value).filter((t) => !t.done)
  return onDay.slice().sort((a, b) => {
    const sa = taskSpan(a)?.start ?? Number.MAX_SAFE_INTEGER
    const sb = taskSpan(b)?.start ?? Number.MAX_SAFE_INTEGER
    if (sa !== sb) return sa - sb
    return a.title.localeCompare(b.title)
  })
})

const cardMode = ref(true)
const cardIndex = ref(0)
const flipping = ref(false)
const flipDir = ref<1 | -1>(1)

const currentCard = computed<Task | undefined>(() => todayCards.value[Math.min(cardIndex.value, Math.max(todayCards.value.length - 1, 0))])

watch(todayCards, (list) => {
  if (list.length === 0) cardIndex.value = 0
  else if (cardIndex.value > list.length - 1) cardIndex.value = list.length - 1
})

function goCard(delta: number): void {
  const n = todayCards.value.length
  if (n <= 1 || flipping.value) return
  const next = cardIndex.value + delta
  if (next < 0 || next > n - 1) return
  flipDir.value = delta > 0 ? 1 : -1
  const reduced = stateLiteOrReduced()
  if (reduced) {
    cardIndex.value = next
    return
  }
  flipping.value = true
  cardIndex.value = next
  setTimeout(() => { flipping.value = false }, 260)
  haptic('light')
}

let touchY = 0
function onCardTouStart(e: any): void {
  touchY = e?.touches?.[0]?.clientY ?? 0
}
function onCardTouEnd(e: any): void {
  const y = e?.changedTouches?.[0]?.clientY ?? touchY
  const dy = y - touchY
  if (Math.abs(dy) < 36) return
  goCard(dy < 0 ? 1 : -1)
}

function setView(v: TaskView): void {
  if (taskView.value === v) return
  taskView.value = v
  haptic('light')
}

function cycleFilter(): void {
  const order: FilterMode[] = ['all', 'high', 'sub']
  const idx = order.indexOf(filterMode.value)
  filterMode.value = order[(idx + 1) % order.length]!
  haptic('light')
}

/* ── 任务动作与详情 ────────────────────────────────────────────────── */

const detailOpen = ref(false)
const detailId = ref('')

/** 长按菜单与删除确认共用一份目标状态：同一时间只允许一个浮层。 */
const menuOpen = ref(false)
const menuTask = ref<Task | null>(null)
const deleteTarget = ref<Task | null>(null)

/** 长按后补发的那次 tap 不应再开详情（手机端 longpress 后仍可能触发 tap）。 */
let swallowTapUntil = 0

function showTask(id: string): void {
  detailId.value = id
  detailOpen.value = true
  haptic('light')
}

function openTask(id: string): void {
  // 菜单 / 确认框开着时，底下的行不该被点穿；长按松手的补发 tap 也要吞掉
  if (menuOpen.value || deleteTarget.value !== null || Date.now() < swallowTapUntil) return
  showTask(id)
}

function toggle(id: string): void {
  const task = data.value.tasks.find((x) => x.id === id)
  if (task === undefined || completingIds.value.has(id) || leavingIds.value.has(id)) return
  haptic('medium')
  if (task.done || taskView.value === 'board') {
    toggleTask(id)
    toast(task.done ? '已恢复为未完成' : '已完成 · 待同步到 DSH')
    return
  }
  // 普通清单先显示打勾，再让行淡出；已完成组只切换静态状态，不播退出。
  markFeedback(completingIds, id)
  afterFeedback(() => {
    toggleTask(id)
    const next = new Set(completingIds.value)
    next.delete(id)
    completingIds.value = next
    toast('已完成 · 待同步到 DSH')
  }, 280)
}

function subText(t: Task): string {
  const done = t.sub.filter((s) => s.done).length
  return `${done}/${t.sub.length}`
}

function isDue(t: Task): boolean {
  return /截止|逾期/.test(t.when)
}

/* ── 长按操作菜单 / 删除 ───────────────────────────────────────────── */

function openRowMenu(t: Task): void {
  if (menuOpen.value || deleteTarget.value !== null) return
  menuTask.value = t
  menuOpen.value = true
  // 长按松手时补齐的 tap 会落在同一行上：吞掉一次，避免菜单刚开又弹详情
  swallowTapUntil = Date.now() + 700
  haptic('medium')
}

function closeMenu(): void {
  menuOpen.value = false
  menuTask.value = null
}

function editFromMenu(): void {
  const t = menuTask.value
  closeMenu()
  swallowTapUntil = 0
  if (t !== null) showTask(t.id)
}

function askDelete(t: Task): void {
  menuOpen.value = false
  menuTask.value = null
  deleteTarget.value = t
  haptic('light')
}

function deleteFromMenu(): void {
  const t = menuTask.value
  closeMenu()
  if (t !== null) askDelete(t)
}

function cancelDelete(): void {
  deleteTarget.value = null
}

function confirmDelete(): void {
  const t = deleteTarget.value
  if (t === null) return
  deleteTarget.value = null
  if (detailOpen.value && detailId.value === t.id) detailOpen.value = false
  markFeedback(leavingIds, t.id)
  haptic('heavy')
  afterFeedback(() => {
    removeTask(t.id)
    const next = new Set(leavingIds.value)
    next.delete(t.id)
    leavingIds.value = next
    toast('已删除任务 · 待同步到其他端')
  }, 120)
}

/* ── 历史动作：恢复 / 日历 ─────────────────────────────────────────── */

function restoreTask(id: string): void {
  updateTask(id, { done: false })
  haptic('medium')
  toast('已恢复为未完成 · 回到清单')
}

/** 只做跳转：日历页按自己的选中日期展示，本页不改它的状态。 */
function openCalendar(): void {
  haptic('light')
  uni.reLaunch({ url: '/pages/calendar/calendar' })
}

/* ── 清已完成（二次确认） ──────────────────────────────────────────── */

const clearOpen = ref(false)

function askClear(): void {
  if (stats.value.done === 0) {
    toast('还没有已完成的任务')
    return
  }
  clearOpen.value = true
  haptic('light')
}

function doClear(): void {
  const n = clearDone()
  clearOpen.value = false
  haptic('medium')
  toast(n > 0 ? `已清掉 ${n} 项已完成` : '没有可清理的任务')
}
</script>

<template>
  <WorkShell active="today" title="今天" :sub="sub">
    <view class="today">
      <!-- 大日期卡 + 环形进度（点击清已完成） -->
      <view class="hero">
        <view class="hero-main">
          <text class="eyebrow">{{ weekday }} · 今天</text>
          <view class="hdateline">
            <text class="hdate">{{ monthDay }}</text>
            <view class="clock">
              <text class="mono hclock">{{ clock }}</text>
              <text class="clock-l">实时</text>
            </view>
          </view>
          <view class="hsub">
            <view class="dot" />
            <text class="hsub-t">已同步 · {{ onlineDevices }} 台设备 · 本机可写</text>
          </view>
        </view>
        <view class="ring" :style="ringStyle" @tap="askClear">
          <view class="ring-in">
            <view class="ring-n">
              <text class="mono rn">{{ stats.done }}</text>
              <text class="rslash">/</text>
              <text class="mono ra">{{ stats.total }}</text>
            </view>
            <text class="mono ring-pct">{{ stats.pct }}%</text>
          </view>
        </view>
      </view>

      <!-- 三个彩色指标 -->
      <view class="stats">
        <view class="stat">
          <view class="si acc"><text class="sig">✓</text></view>
          <view class="sbody">
            <text class="mono sn">{{ doneToday }}</text>
            <text class="sl">今日完成</text>
          </view>
        </view>
        <view class="stat">
          <view class="si warn"><text class="sig">◷</text></view>
          <view class="sbody">
            <text class="mono sn">{{ pendingFocus }}</text>
            <text class="sl">待专注</text>
          </view>
        </view>
        <view class="stat">
          <view class="si danger"><text class="sig">!</text></view>
          <view class="sbody">
            <text class="mono sn">{{ highPri }}</text>
            <text class="sl">高优先</text>
          </view>
        </view>
      </view>

      <!-- 快速记录 -->
      <view class="quick">
        <view class="quickin">
          <text class="qplus">＋</text>
          <input
            :key="quickKey"
            v-model="quick"
            class="qin"
            placeholder="记一件事，回车即存…"
            placeholder-class="ph"
            confirm-type="done"
            :confirm-hold="true"
            :focus="inputFocus"
            :maxlength="80"
            @confirm="addQuick"
          />
          <view class="qdev" @tap="cycleQuickDev">
            <text class="qdev-t">{{ quickDevName }}</text>
          </view>
          <view class="qadd fb-press" :class="{ 'fb-disabled': quick.trim() === '' }" :aria-disabled="quick.trim() === ''" @tap="addQuick"><text class="qadd-g">＋</text></view>
        </view>
        <view class="quickhint">
          <text class="mono">回车连建 · 不打断输入</text>
          <view class="sp" />
          <text class="mono dim">{{ data.tasks.length }} 项 · 待同步 {{ pendingSync }}</text>
        </view>
      </view>

      <!-- 视图切换 + 筛选 -->
      <view class="tools">
        <view class="seg">
          <view class="seg-btn" :class="{ on: taskView === 'list' }" @tap="setView('list')"><text>清单</text></view>
          <view class="seg-btn" :class="{ on: taskView === 'board' }" @tap="setView('board')"><text>看板</text></view>
        </view>
        <view class="fbtn" :class="{ on: filterMode !== 'all' }" @tap="cycleFilter">
          <text>{{ FILTER_LABEL[filterMode] }}</text>
        </view>
      </view>

      <!-- 清单：只当日 + 按时间排序 + 台历翻页卡片 -->
      <view v-if="taskView === 'list'" :key="`list-${filterMode}`" class="calwrap">
        <view class="calbar">
          <view class="caltoggle">
            <view class="ct-btn" :class="{ on: cardMode }" @tap="cardMode = true"><text>翻页</text></view>
            <view class="ct-btn" :class="{ on: !cardMode }" @tap="cardMode = false"><text>列表</text></view>
          </view>
          <text class="calbar-n mono">{{ todayCards.length }} 项 · 按时间</text>
        </view>

        <!-- 翻页卡片：一页一条，按时间升序 -->
        <view v-if="cardMode" class="calpage today">
          <view class="calbind">
            <view v-for="i in 11" :key="i" class="hole" />
          </view>

          <view class="calhead">
            <view class="caldate">
              <text class="calmonth mono">{{ todayMD.month }}</text>
              <text class="calbig mono">{{ todayMD.day }}</text>
            </view>
            <view class="calmeta">
              <text class="calsub">今天 · {{ todayMD.week }}</text>
              <text class="calcoun mono">{{ todayCards.length }} 项待办</text>
            </view>
            <text v-if="todayCards.length > 0" class="calidx mono">{{ cardIndex + 1 }} / {{ todayCards.length }}</text>
          </view>

          <view class="flipzone" @touchstart="onCardTouStart" @touchend="onCardTouEnd">
            <view v-if="todayCards.length > 2" class="peek p3" />
            <view v-if="todayCards.length > 1" class="peek p2" />
            <view
              v-if="currentCard !== undefined"
              :key="currentCard.id"
              class="flipcard"
              :class="{ up: flipDir === 1, down: flipDir === -1, flipping }"
              @tap="openTask(currentCard.id)"
              @longpress="openRowMenu(currentCard)"
            >
              <view class="fc-top">
                <text class="fc-when mono" :class="{ due: isDue(currentCard) }">{{ currentCard.when }}</text>
                <text class="fc-st" :style="statusChipStyle(currentCard)">{{ statusLabel(currentCard) }}</text>
                <view class="sp" />
                <view class="tmenu" @tap.stop="openRowMenu(currentCard)"><text class="tmenu-g">⋯</text></view>
              </view>
              <text class="fc-title">{{ currentCard.title }}</text>
              <view class="fc-meta">
                <text v-if="isCrossDay(currentCard)" class="tmi span mono">{{ spanLabel(currentCard) }}</text>
                <text v-if="currentCard.sub.length > 0" class="tmi mono">{{ subText(currentCard) }}</text>
                <text v-for="tag in currentCard.tags" :key="tag" class="tmi">#{{ tag }}</text>
                <text v-if="currentCard.pri === 'high'" class="tmi high">高优先</text>
              </view>
              <view class="fc-acts">
                <view class="fc-done" @tap.stop="toggle(currentCard.id)">
                  <text class="fc-cg" />
                  <text>完成</text>
                </view>
                <text class="fc-hint">上滑/下滑翻页</text>
              </view>
            </view>

            <view v-else class="flipempty fb-empty">
              <text class="fb-empty-icon">☀</text>
              <text>今天还没有安排</text>
              <text class="fe-d">用上面的输入框记一件，或去日历排期</text>
            </view>
          </view>

          <view v-if="todayCards.length > 1" class="calnav">
            <view class="navbtn" :class="{ mut: cardIndex === 0 }" @tap="goCard(-1)"><text>↑</text></view>
            <view class="dots">
              <view v-for="(t, i) in todayCards" :key="t.id" class="dot" :class="{ on: i === cardIndex }" />
            </view>
            <view class="navbtn" :class="{ mut: cardIndex >= todayCards.length - 1 }" @tap="goCard(1)"><text>↓</text></view>
          </view>

          <view class="calfoot">
            <text class="calfoot-t mono">TODAY</text>
            <text class="calfoot-d">只显示今天 · 已完成进日历</text>
          </view>
          <view class="calfold" />
        </view>

        <!-- 列表模式：同样的当日集合，按时间排 -->
        <view v-else class="callist">
          <view
            v-for="(t, index) in todayCards"
            :key="t.id"
            class="trow"
            :class="[{ cur: detailOpen && detailId === t.id }, ...taskFeedbackClass(t, index, false)]"
            @tap="openTask(t.id)"
            @longpress="openRowMenu(t)"
          >
            <view class="tbar" :style="statusStyle(t)" />
            <view class="check" :class="{ on: completingIds.has(t.id) }" @tap.stop="toggle(t.id)">
              <text class="cg"><text class="cg-line" /><text class="cg-line" /></text>
            </view>
            <view class="tbody">
              <text class="tt">{{ t.title }}</text>
              <view class="tmeta">
                <text class="tmi st" :style="statusChipStyle(t)">{{ statusLabel(t) }}</text>
                <text v-if="isCrossDay(t)" class="tmi span mono">{{ spanLabel(t) }}</text>
                <text v-if="t.sub.length > 0" class="tmi mono">{{ subText(t) }}</text>
                <text v-for="tag in t.tags" :key="tag" class="tmi">#{{ tag }}</text>
                <text v-if="t.pri === 'high'" class="tmi high">高优先</text>
              </view>
            </view>
            <view class="tright">
              <text class="twhen mono" :class="{ due: isDue(t) }">{{ t.when }}</text>
              <view class="tright-r">
                <view v-if="t.sync" class="syncdot" />
                <view class="tmenu" @tap.stop="openRowMenu(t)"><text class="tmenu-g">⋯</text></view>
              </view>
            </view>
          </view>

          <view v-if="todayCards.length === 0" class="calempty fb-empty">
            <text class="fb-empty-icon">☀</text>
            <text>今天还没有安排</text>
          </view>
        </view>
      </view>

      <!-- 看板 -->
      <scroll-view v-else-if="taskView === 'board'" :key="`board-${filterMode}`" scroll-x class="board-scroll" :show-scrollbar="false">
        <view class="board">
          <view v-for="col in board" :key="col.key" class="bcol">
            <view class="bh">
              <view class="bdot" :class="col.key" />
              <text class="bt">{{ col.label }}</text>
              <text class="mono bn">{{ col.items.length }}</text>
            </view>
            <view
              v-for="(t, index) in col.items"
              :key="t.id"
              class="bcard"
              :class="[t.pri, statusKeyOf(t), ...taskFeedbackClass(t, index)]"
              @tap="openTask(t.id)"
              @longpress="openRowMenu(t)"
            >
              <text class="bct">{{ t.title }}</text>
              <view class="bcm">
                <text class="bchip mono">{{ t.when }}</text>
                <text class="devbadge">{{ t.dev }}</text>
                <view v-if="t.sync" class="syncdot" />
              </view>
            </view>
            <view v-if="col.items.length === 0" class="bcol-empty fb-empty"><text class="fb-empty-icon">＋</text><text>从快速记录新建任务，再在这里推进状态</text></view>
          </view>
        </view>
      </scroll-view>

    </view>

    <!-- 长按操作菜单（页面自绘，与全应用弹层观感一致） -->
    <view v-if="menuOpen" class="mask menu-mask" @tap="closeMenu">
      <view class="menu" @tap.stop>
        <view class="grab" />
        <view class="menu-head">
          <text class="menu-title">{{ menuTask?.title ?? '任务' }}</text>
          <text class="menu-sub">选择要做的操作</text>
        </view>
        <view class="menu-item" @tap="editFromMenu">
          <view class="mi-ic"><text>✎</text></view>
          <view class="mi-body">
            <text class="mi-t">编辑</text>
            <text class="mi-h">打开任务详情，改标题 / 日期 / 子待办</text>
          </view>
          <view class="chev" />
        </view>
        <view class="menu-sep" />
        <view class="menu-item danger" @tap="deleteFromMenu">
          <view class="mi-ic"><text>✕</text></view>
          <view class="mi-body">
            <text class="mi-t">删除</text>
            <text class="mi-h">从当前设备域移除，并同步到其它端</text>
          </view>
        </view>
        <view class="menu-cancel" @tap="closeMenu"><text>取消</text></view>
      </view>
    </view>

    <!-- 删除任务：二次确认 -->
    <view v-if="deleteTarget !== null" class="mask" @tap="cancelDelete">
      <view class="modal" @tap.stop>
        <text class="mh">删除「{{ deleteTarget.title }}」？</text>
        <text class="mb">
          会从「{{ deviceName() }}」数据域移除这条任务，并打 tombstone 同步到其他端。删除后不可撤销；只想从清单收走的话，用「完成」。
        </text>
        <view class="mf">
          <view class="btn ghost" @tap="cancelDelete"><text>取消</text></view>
          <view class="btn danger" @tap="confirmDelete"><text>删除任务</text></view>
        </view>
      </view>
    </view>

    <!-- 任务详情抽屉 -->
    <WorkTaskDetail :visible="detailOpen" :task-id="detailId" @close="detailOpen = false" />

    <!-- 清已完成：二次确认 -->
    <view v-if="clearOpen" class="mask" @tap="clearOpen = false">
      <view class="modal" @tap.stop>
        <text class="mh">清掉已完成？</text>
        <text class="mb">
          将从「{{ deviceName() }}」数据域移除 {{ stats.done }} 项已完成任务。本机立即生效，M2 同步后其他设备跟随。
        </text>
        <view class="mf">
          <view class="btn ghost" @tap="clearOpen = false"><text>取消</text></view>
          <view class="btn primary" @tap="doClear"><text>清掉 {{ stats.done }} 项</text></view>
        </view>
      </view>
    </view>
  </WorkShell>
</template>

<style lang="scss" scoped>
.today {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 2px;
}

/* ── 大日期卡 + 环形进度 ─────────────────────────────────────────── */

.hero {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border-radius: var(--r-lg);
  border: 1px solid var(--bd);
  background: linear-gradient(160deg, var(--s1), var(--s2));
}

.hero-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.eyebrow {
  font-size: 10.5px;
  color: var(--acc);
  letter-spacing: 0.06em;
}

.hdate {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.5px;
  line-height: 1.25;
  color: var(--t1);
}

/* 日期旁的实时时钟：只在 hero 里占一行，宽度不够时自动换行 */
.hdateline {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
}

.clock {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 7px;
  border: 1px solid var(--bd);
  background: var(--s2);
}

.hclock {
  font-size: 13px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: 0.03em;
  color: var(--t2);
  font-variant-numeric: tabular-nums;
}

.clock-l {
  font-size: 8.5px;
  letter-spacing: 0.08em;
  color: var(--t3);
}

.hsub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  min-width: 0;
}

.dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--ok);
}

.hsub-t {
  font-size: 10px;
  color: var(--t3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ring {
  width: 88px;
  height: 88px;
  flex: 0 0 88px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  transition: transform var(--t-fast) var(--ease-out);
}

.ring:active { transform: scale(0.96); }

.ring-in {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: var(--s1);
  border: 1px solid var(--bd);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}

.ring-n {
  display: flex;
  align-items: baseline;
  gap: 1px;
}

.rn { font-size: 19px; font-weight: 700; color: var(--t1); line-height: 1.1; }
.rslash { font-size: 11px; color: var(--t3); }
.ra { font-size: 11px; color: var(--t3); }
.ring-pct { font-size: 9px; color: var(--acc); letter-spacing: 0.04em; }

/* ── 三个指标 ───────────────────────────────────────────────────── */

.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.stat {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 9px 9px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--s1);
}

.si {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
}

.si.acc { color: var(--acc); background: var(--acc-soft); }
.si.warn { color: var(--warn); background: var(--warn-soft); }
.si.danger { color: var(--danger); background: var(--danger-soft); }

.sig { line-height: 1; }

.sbody {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.sn { font-size: 14px; font-weight: 700; color: var(--t1); line-height: 1.15; }

.sl {
  font-size: 9px;
  color: var(--t3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── 快速记录 ───────────────────────────────────────────────────── */

.quick {
  border-radius: var(--r-lg);
  border: 1px solid var(--bd);
  background: var(--s1);
}

.quickin {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 9px 9px 11px;
}

.qplus {
  flex: 0 0 16px;
  width: 16px;
  text-align: center;
  font-size: 16px;
  color: var(--t3);
  line-height: 1;
}

.qin {
  flex: 1;
  min-width: 0;
  height: 32px;
  font-size: 14px;
  color: var(--t1);
  background: transparent;
}

.qdev {
  flex: 0 1 auto;
  max-width: 88px;
  height: 26px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t2);
  display: flex;
  align-items: center;
}

.qdev-t {
  font-size: 9.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.qadd {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  border-radius: 10px;
  background: var(--acc);
  color: var(--acc-ink);
  display: grid;
  place-items: center;
  transition: transform var(--t-fast) var(--ease-out);
}

.qadd:active { transform: scale(0.92); }
.qadd-g { font-size: 18px; font-weight: 600; line-height: 1; }

.quickhint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 11px 8px;
  font-size: 9px;
  color: var(--t3);
}

.dim { color: var(--t3); }
.sp { flex: 1; }

/* ── 视图切换与筛选 ─────────────────────────────────────────────── */

.tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 11px;
  border: 1px solid var(--bd);
  background: var(--s2);
}

.seg-btn {
  height: 27px;
  padding: 0 12px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--t3);
}

.seg-btn.on {
  background: var(--s1);
  color: var(--acc);
  box-shadow: inset 0 0 0 1px var(--bd);
}

.fbtn {
  margin-left: auto;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--bd);
  background: var(--s1);
  color: var(--t3);
  display: flex;
  align-items: center;
  font-size: 10px;
}

.fbtn.on {
  color: var(--acc);
  border-color: var(--bd-strong);
  background: var(--acc-soft);
}

/* ── 分组与任务行 ───────────────────────────────────────────────── */

/* ── 台历翻页页：一张卡 = 一页日历 ─────────────────────────────────── */
.calpages {
  display: flex;
  flex-direction: column;
  gap: 16px;
  perspective: 900px;
}

.calpage {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--bd);
  border-radius: 18px;
  background: var(--s1);
  box-shadow:
    0 1px 0 var(--bd),
    0 10px 26px color-mix(in srgb, var(--t1) 9%, transparent),
    0 2px 6px color-mix(in srgb, var(--t1) 5%, transparent);
  transform-origin: top center;
}

/* 装订条 + 打孔 */
.calbind {
  display: flex;
  align-items: center;
  justify-content: space-evenly;
  height: 20px;
  padding: 0 14px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--acc) 9%, var(--s2)), var(--s1));
  border-bottom: 1px solid var(--bd);
}

.hole {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg);
  box-shadow: inset 0 1px 2px color-mix(in srgb, var(--t1) 30%, transparent), 0 1px 0 color-mix(in srgb, var(--s1) 80%, transparent);
}

/* 日期块 */
.calhead {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px 10px;
}

.caldate {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 56px;
  padding: 6px 8px;
  border-radius: 12px;
  background: var(--acc-soft);
  border: 1px solid color-mix(in srgb, var(--acc) 26%, transparent);
}

.calmonth { font-size: 8px; letter-spacing: 0.12em; color: var(--acc); text-transform: uppercase; }
.calbig { font-size: 26px; font-weight: 700; line-height: 1.05; letter-spacing: -0.04em; color: var(--t1); }

.calmeta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.calsub { font-size: 11.5px; font-weight: 650; color: var(--t1); letter-spacing: 0.01em; }
.calcoun { font-size: 9px; color: var(--t3); }

.calstat { flex: 0 0 auto; }
.caldot { width: 7px; height: 7px; border-radius: 50%; background: var(--acc); }
.caldot.date { background: var(--st-doing); }
.caldot.inbox { background: var(--t3); }

/* 页面上的任务行：淡化成"纸上的行"，不再各自带卡片底 */
.calrows { display: flex; flex-direction: column; padding: 0 14px 4px; }

.calrows .trow {
  background: transparent;
  border-color: transparent;
  border-radius: 0;
  border-bottom: 1px dashed color-mix(in srgb, var(--bd-strong) 55%, transparent);
  padding: 11px 2px;
}
.calrows .trow:last-child { border-bottom: 0; }
.calrows .trow:active { background: var(--s2); border-radius: 8px; }

.calempty { padding: 14px 0 16px; }

/* 页脚 + 右下折角 */
.calfoot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px 10px;
  border-top: 1px solid var(--bd);
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--s2) 70%, transparent));
}
.calfoot-t { font-size: 7px; letter-spacing: 0.18em; color: var(--t3); }
.calfoot-d { font-size: 8px; color: var(--t3); }

.calfold {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 20px;
  height: 20px;
  background: linear-gradient(135deg, transparent 48%, color-mix(in srgb, var(--t1) 10%, var(--s2)) 50%);
  box-shadow: -1px -1px 0 color-mix(in srgb, var(--bd-strong) 60%, transparent);
  pointer-events: none;
}

/* ── 工具条：翻页 / 列表切换 ── */
.calbar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.caltoggle { display: flex; padding: 3px; gap: 2px; border-radius: 999px; background: var(--s2); border: 1px solid var(--bd); }
.ct-btn { padding: 5px 12px; border-radius: 999px; font-size: 10.5px; color: var(--t3); transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out); }
.ct-btn.on { background: var(--s1); color: var(--t1); box-shadow: 0 1px 3px color-mix(in srgb, var(--t1) 12%, transparent); }
.calbar-n { margin-left: auto; font-size: 9px; color: var(--t3); }

.calidx { font-size: 10px; color: var(--t2); padding: 3px 8px; border-radius: 999px; background: var(--s3); }

/* ── 翻页卡片 ── */
.flipzone { position: relative; padding: 2px 14px 12px; min-height: 176px; }
.peek { position: absolute; left: 20px; right: 20px; height: 100%; border-radius: 14px; border: 1px solid var(--bd); background: var(--s2); }
.peek.p1 { top: 8px; opacity: 0.55; }
.peek.p2 { top: 14px; left: 26px; right: 26px; opacity: 0.3; }
.peek.p3 { top: 19px; left: 32px; right: 32px; opacity: 0.16; }

.flipcard {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 168px;
  padding: 15px 16px 13px;
  border-radius: 14px;
  border: 1px solid var(--bd-strong);
  background:
    linear-gradient(180deg, var(--glass-hi, transparent), transparent 42%),
    var(--s1);
  box-shadow: 0 10px 24px color-mix(in srgb, var(--t1) 10%, transparent), 0 1px 0 var(--bd);
  transform-origin: top center;
}
.flipcard.flipping { animation: flip-in-up 260ms var(--ease-out) both; }
.flipcard.flipping.down { animation-name: flip-in-down; }
@keyframes flip-in-up {
  from { opacity: 0; transform: translateY(16px) rotateX(24deg) scale(0.985); }
  to { opacity: 1; transform: translateY(0) rotateX(0) scale(1); }
}
@keyframes flip-in-down {
  from { opacity: 0; transform: translateY(-16px) rotateX(-24deg) scale(0.985); }
  to { opacity: 1; transform: translateY(0) rotateX(0) scale(1); }
}

.fc-top { display: flex; align-items: center; gap: 8px; }
.fc-when { font-size: 13px; font-weight: 650; color: var(--t2); letter-spacing: 0.02em; }
.fc-when.due { color: var(--danger); }
.fc-st { font-size: 9px; padding: 2px 7px; border-radius: 999px; }
.fc-title { font-size: 17px; font-weight: 680; line-height: 1.35; letter-spacing: -0.01em; color: var(--t1); }
.fc-meta { display: flex; flex-wrap: wrap; gap: 6px; }
.fc-acts { margin-top: auto; display: flex; align-items: center; gap: 10px; padding-top: 6px; border-top: 1px dashed color-mix(in srgb, var(--bd-strong) 50%, transparent); }
.fc-done { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; background: var(--acc-soft); color: var(--acc); font-size: 10.5px; font-weight: 600; }
.fc-cg { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid currentColor; }
.fc-hint { margin-left: auto; font-size: 9px; color: var(--t3); }

.flipempty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 34px 0; text-align: center; color: var(--t2); font-size: 11.5px; }
.fe-d { font-size: 10px; color: var(--t3); }

.calnav { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 0 14px 10px; }
.navbtn { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; border: 1px solid var(--bd); background: var(--s1); color: var(--t2); font-size: 12px; }
.navbtn.mut { opacity: 0.35; }
.dots { display: flex; align-items: center; gap: 5px; }
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--bd-strong); transition: background var(--t-fast) var(--ease-out), transform var(--t-fast) var(--ease-out); }
.dot.on { background: var(--acc); transform: scale(1.35); }

.callist { display: flex; flex-direction: column; gap: 8px; }

/* 翻页入场 */
.calpage.enter { animation: page-flip 320ms var(--ease-out) both; }
@keyframes page-flip {
  from { opacity: 0; transform: translateY(10px) rotateX(-7deg); }
  to { opacity: 1; transform: translateY(0) rotateX(0); }
}

.trow {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--s1);
  transition: background var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out);
  overflow: hidden;
}

/* 左侧 3px 状态色条：未开始 / 进行中 / 已完成三套色，取主题令牌 */
.tbar {
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--st-doing);
}

.trow:active { background: var(--s2); }
.trow.cur { border-color: var(--bd-strong); }

/* 已完成：绿色状态条保留，文字降透明度（不再整行压暗，否则状态色也灰了） */
.trow.done .tt {
  color: var(--st-done);
  opacity: 0.72;
  text-decoration: line-through;
}

.trow.done .tmeta { opacity: 0.7; }

.check {
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  margin-top: 1px;
  border-radius: 50%;
  border: 1.6px solid var(--bd-strong);
  display: grid;
  place-items: center;
  color: transparent;
  transition: background var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out);
}

.check { transition: transform 90ms ease-out; }
.check:active { transform: scale(0.97); }

.check.on {
  background: var(--st-done);
  border-color: var(--st-done);
  color: var(--acc-ink);
}

.check.on { animation: check-pop 280ms var(--ease-out); }
@keyframes check-pop {
  0% { transform: scale(0.78); }
  65% { transform: scale(1.06); }
  100% { transform: scale(1); }
}
.cg { position: relative; display: block; width: 11px; height: 9px; }
.cg-line {
  position: absolute;
  height: 1.6px;
  border-radius: 1px;
  background: currentColor;
  transform-origin: left center;
}
.cg-line:first-child { width: 5px; left: 0; top: 4px; transform: rotate(45deg) scaleX(0); }
.cg-line:last-child { width: 9px; left: 4px; top: 7px; transform: rotate(-48deg) scaleX(0); }
.check.on .cg-line:first-child { animation: check-short 100ms ease-out 70ms forwards; }
.check.on .cg-line:last-child { animation: check-long 150ms ease-out 150ms forwards; }
@keyframes check-short { to { transform: rotate(45deg) scaleX(1); } }
@keyframes check-long { to { transform: rotate(-48deg) scaleX(1); } }
/* 已完成组恢复静态对勾，不因刷新或切换视图反复播描线。 */
.trow.done:not(.fb-exit) .cg-line:first-child { transform: rotate(45deg) scaleX(1); animation: none; }
.trow.done:not(.fb-exit) .cg-line:last-child { transform: rotate(-48deg) scaleX(1); animation: none; }

.tbody { flex: 1; min-width: 0; }

.tt {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--t1);
  word-break: break-word;
}

.tmeta {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.tmi {
  font-size: 9px;
  line-height: 1.2;
  color: var(--t3);
  background: var(--s2);
  border: 1px solid var(--bd);
  padding: 2px 6px;
  border-radius: 5px;
}

.tmi.high {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: color-mix(in srgb, var(--danger) 30%, transparent);
}

.tmi.warn {
  color: var(--warn);
  background: var(--warn-soft);
  border-color: color-mix(in srgb, var(--warn) 30%, transparent);
}

.tmi.dev { color: var(--t2); }

/* 状态文案：颜色由行内 var(--st-*) 决定，与左侧色条同一套 */
.tmi.st {
  font-weight: 600;
  background: var(--s2);
}

/* 跨天区间：等宽字体 + 等宽数字，起止两端对齐好读 */
.tmi.span {
  color: var(--t2);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.1px;
}

.tright {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  padding-top: 1px;
}

.twhen {
  font-size: 9.5px;
  color: var(--t3);
  white-space: nowrap;
}

.twhen.due { color: var(--warn); }

.syncdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}

/* 右侧：同步点 + 更多入口（长按的可见替代，桌面也能点） */
.tright-r {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tmenu {
  width: 24px;
  height: 24px;
  margin: -4px -4px -4px 0;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: var(--t3);
}

.tmenu:active { background: var(--s3); color: var(--t1); }
.tmenu-g { font-size: 15px; line-height: 1; letter-spacing: 1px; }

.gempty {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 14px 10px 16px;
  text-align: center;
  font-size: 10.5px;
  line-height: 1.8;
  color: var(--t3);
  border: 1px dashed var(--bd);
  border-radius: var(--r-md);
}

/* ── 历史视图 ───────────────────────────────────────────────────── */

.history {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.history-hint {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 2px;
}

.hh-t {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--t2);
}

.hh-n {
  margin-left: auto;
  font-size: 9px;
  color: var(--t3);
}

.hrow {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--s1);
  transition: background var(--t-fast) var(--ease-out);
}

.hrow:active { background: var(--s2); }

.hbody {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.ht {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--t2);
  word-break: break-word;
}

.hmeta {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.hmi {
  font-size: 9px;
  line-height: 1.2;
  color: var(--t3);
  background: var(--s2);
  border: 1px solid var(--bd);
  padding: 2px 6px;
  border-radius: 5px;
}

.hmi.time {
  color: var(--acc);
  background: var(--acc-soft);
  border-color: transparent;
}

.hmi.date { color: var(--t2); }

.hacts {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.hact {
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t2);
  display: inline-flex;
  align-items: center;
  font-size: 10px;
}

.hact:active { background: var(--s3); }

.hact.cal {
  color: var(--acc);
  background: var(--acc-soft);
  border-color: transparent;
}

.hact.del {
  margin-left: auto;
  color: var(--danger);
  background: var(--danger-soft);
  border-color: transparent;
}

.history-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 34px 16px;
  border: 1px dashed var(--bd);
  border-radius: var(--r-md);
  text-align: center;
}

.he-g { font-size: 22px; color: var(--t3); line-height: 1; }
.he-t { font-size: 12px; font-weight: 600; color: var(--t2); }

.he-d {
  max-width: 260px;
  font-size: 10px;
  line-height: 1.7;
  color: var(--t3);
}

/* ── 看板 ───────────────────────────────────────────────────────── */

.board-scroll { width: 100%; }

.board {
  display: flex;
  gap: 9px;
  align-items: flex-start;
}

.bcol {
  flex: 0 0 78%;
  max-width: 300px;
  padding: 10px;
  border-radius: var(--r-lg);
  border: 1px solid var(--bd);
  background: var(--s1);
  min-height: 140px;
}

.bh {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 2px 10px;
}

.bdot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--st-doing);
}

.bdot.doing { background: var(--st-doing); }
.bdot.waiting { background: var(--st-waiting); }

.bt {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--t3);
}

.bn {
  margin-left: auto;
  font-size: 9px;
  color: var(--t2);
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--s3);
}

.bcard {
  position: relative;
  overflow: hidden;
  padding: 10px 10px 10px 13px;
  margin-bottom: 8px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--s2);
}

.bcard::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--acc);
}

.bcard.high::before { background: var(--danger); }
.bcard.low::before { background: var(--t3); }

/* 卡内左侧和清单行同一套状态色（状态优先于优先级色条） */
.bcard.waiting::before { background: var(--st-waiting); }
.bcard.next::before,
.bcard.doing::before { background: var(--st-doing); }
.bcard.done::before { background: var(--st-done); }

.bct {
  display: block;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--t1);
}

.bcm {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.bchip {
  font-size: 9px;
  color: var(--t2);
  background: var(--s3);
  padding: 2px 6px;
  border-radius: 5px;
}

.devbadge {
  font-size: 8.5px;
  color: var(--t2);
  background: var(--s3);
  border: 1px solid var(--bd);
  padding: 2px 5px;
  border-radius: 4px;
}

.bcol-empty {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 14px 6px;
  text-align: center;
  font-size: 10px;
  color: var(--t3);
  border: 1px dashed var(--bd);
  border-radius: var(--r-sm);
}

/* ── 长按操作菜单 ───────────────────────────────────────────────── */

.mask.menu-mask {
  align-items: flex-end;
  padding: 0;
  z-index: 96;
}

.menu {
  width: 100%;
  max-width: 520px;
  margin: 0 auto;
  padding: 0 12px calc(10px + var(--safe-bottom-real, 0px));
  border-top: 1px solid var(--bd-strong);
  border-top-left-radius: 18px;
  border-top-right-radius: 18px;
  background: var(--s1);
  box-shadow: 0 -8px 32px color-mix(in srgb, var(--bg-grad-3) 60%, transparent);
  animation: menu-up var(--t-mid) var(--ease-out);
}

@keyframes menu-up {
  from { transform: translateY(18px); opacity: 0.6; }
  to { transform: translateY(0); opacity: 1; }
}

.grab {
  width: 34px;
  height: 4px;
  border-radius: 4px;
  background: var(--s3);
  margin: 8px auto 4px;
}

.menu-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 6px 12px;
}

.menu-title {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--t1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu-sub { font-size: 9.5px; color: var(--t3); }

.menu-item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 8px;
  border-radius: 12px;
}

.menu-item:active { background: var(--s2); }

.mi-ic {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: 10px;
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--acc);
  display: grid;
  place-items: center;
  font-size: 13px;
}

.menu-item.danger .mi-ic {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: transparent;
}

.mi-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mi-t { font-size: 13.5px; font-weight: 600; color: var(--t1); }
.menu-item.danger .mi-t { color: var(--danger); }
.mi-h { font-size: 10px; line-height: 1.5; color: var(--t3); }

.menu-sep {
  height: 1px;
  margin: 5px 10px;
  background: var(--bd);
}

.menu-cancel {
  height: 46px;
  margin: 10px 4px 2px;
  border-radius: 12px;
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t2);
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 600;
}

.menu-cancel:active { background: var(--s3); }

/* ── 清已完成确认 ───────────────────────────────────────────────── */

.mask {
  position: fixed;
  inset: 0;
  z-index: 95;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 20px;
  background: color-mix(in srgb, var(--bg-grad-3) 74%, transparent);
  animation: mask-in 150ms var(--ease-out);
}

@keyframes mask-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.modal {
  width: 100%;
  max-width: 400px;
  padding: 18px;
  border-radius: var(--r-lg);
  border: 1px solid var(--bd-strong);
  background: var(--s1);
}

.mh {
  display: block;
  font-size: 15px;
  font-weight: 700;
  color: var(--t1);
}

.mb {
  display: block;
  margin-top: 10px;
  font-size: 11.5px;
  line-height: 1.8;
  color: var(--t2);
}

.mf {
  display: flex;
  gap: 9px;
  margin-top: 16px;
}

.btn {
  flex: 1;
  height: 42px;
  border-radius: var(--r-md);
  display: grid;
  place-items: center;
  font-size: 12.5px;
  font-weight: 600;
}

.btn.ghost {
  background: var(--s2);
  border: 1px solid var(--bd);
  color: var(--t2);
}

.btn.primary {
  background: var(--acc);
  color: var(--acc-ink);
}

.btn.danger {
  background: var(--danger-soft);
  border: 1px solid var(--danger-bd);
  color: var(--danger);
}

.ph { color: var(--t3); }

/* ── 平板：内容更松，看板三列铺开 ───────────────────────────────── */

@media (min-width: 820px) {
  .today { gap: 16px; }
  .hero { padding: 20px; }
  .hdate { font-size: 32px; }
  .ring { width: 104px; height: 104px; flex-basis: 104px; }
  .ring-in { width: 86px; height: 86px; }
  .quickin { padding: 11px 11px 11px 14px; }
  .board {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    width: 100%;
  }
  .bcol { flex: 1 1 0; max-width: none; }
}

/* 大平板：今天屏是单列阅读，铺满 1120 会让标题和右侧时间隔得太远 */
@media (min-width: 1000px) {
  .today { max-width: 860px; margin: 0 auto; width: 100%; }
}
</style>
