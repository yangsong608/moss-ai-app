<script setup lang="ts">
/**
 * 日历（周 / 月）。
 *
 * 周视图是主视图：7 天 × 8:00–21:00 网格，任务按 `date + when(时:分)` 落成色块；
 * 月视图用来"找密度"——点某天直接跳回那一周。下方永远跟着选中日期的安排列表，
 * 加一条也在这里（时间选择器决定它会不会出现在网格里）。
 *
 * 数据只读 @/core/workbench 的 DomainData；改期 / 改状态在共用详情抽屉里完成。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import WorkShell from '@/components/WorkShell.vue'
import WorkTaskDetail from '@/components/WorkTaskDetail.vue'
import {
  WEEKDAYS,
  addTask,
  isoDay,
  useWork,
  work,
  type Task,
} from '@/core/workbench'
import { haptic } from '@/core/haptic'

const { data } = useWork()

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
const nowTick = ref(new Date())
/** 手机上 7 天放不进一屏：进页面先把选中那天滚进视野，否则用户看到的是空白的周一。 */
const weekScrollLeft = ref(0)

watch(
  () => work.deviceId,
  () => { detailOpen.value = false },
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
  detailId.value = id
  detailOpen.value = true
  haptic('light')
}

function evStyle(e: CalEvent): string {
  return `top:${e.top}px;height:${e.height}px;left:${e.leftPct}%;width:${e.widthPct}%`
}

function onPickTime(e: any): void {
  const v = String(e?.detail?.value ?? '')
  if (v !== '') quickTime.value = v
}

function quickAdd(): void {
  const title = quickTitle.value.trim()
  if (title === '') {
    toast('先写一句要办的事')
    return
  }
  addTask(title, { date: anchor.value, when: quickTime.value })
  quickTitle.value = ''
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
    <view class="cal">
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
                @tap="selectDate(d.iso)"
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
                :class="{ today: d.isToday }"
                @tap="selectDate(d.iso)"
              >
                <view v-for="h in HOURS" :key="h" class="slot" />

                <view
                  v-for="ev in d.events"
                  :key="ev.id"
                  class="evbar"
                  :class="[ev.tone, { done: ev.done }]"
                  :style="evStyle(ev)"
                  @tap.stop="openTask(ev.id)"
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
            :class="{ out: c.out, today: c.isToday, sel: c.sel }"
            @tap="pickMonthDay(c.iso)"
          >
            <text class="dn mono">{{ c.d }}</text>
            <view class="mdots">
              <view v-for="(tone, i) in c.dots" :key="i" class="mdot" :class="tone" />
            </view>
          </view>
        </view>
        <text class="mhint">点一天跳到那一周的周视图</text>
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
    </view>

    <!-- 共用任务详情 -->
    <WorkTaskDetail :visible="detailOpen" :task-id="detailId" @close="detailOpen = false" />
  </WorkShell>
</template>

<style lang="scss" scoped>
.cal {
  display: flex;
  flex-direction: column;
  padding-top: 2px;
}

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

.hwd { font-size: 9px; color: var(--t3); }
.hd { font-size: 11px; font-weight: 600; color: var(--t2); }
.hc.today .hwd, .hc.today .hd { color: var(--acc); }

.weekgrid {
  display: grid;
  grid-template-columns: 38px repeat(7, minmax(96px, 1fr));
  position: relative;
}

.hourcol { border-right: 1px solid var(--bd); }

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
