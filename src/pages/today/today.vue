<script setup lang="ts">
/**
 * 今天（默认屏）。
 *
 * 一屏回答三件事：现在什么进度（大日期 + 环形进度）、今天还有什么（清单 / 看板）、
 * 顺手记一件（快速记录，回车连建、不打断输入）。
 *
 * 数据全部来自 @/core/workbench；本页只做投影和写动作，不自己存状态。
 * 环形进度点击 = 清已完成（必须二次确认，删除是不可逆的）。
 */
import { computed, reactive, ref, watch } from 'vue'
import WorkShell from '@/components/WorkShell.vue'
import WorkTaskDetail from '@/components/WorkTaskDetail.vue'
import {
  DEVICES,
  WEEKDAYS,
  addTask,
  clearDone,
  deviceName,
  domainStats,
  groupOf,
  isoDay,
  switchDevice,
  toggleTask,
  todayTasks,
  useWork,
  work,
  type Task,
  type TaskGroup,
  type TaskStatus,
} from '@/core/workbench'
import { haptic } from '@/core/haptic'

const { data } = useWork()

const NOW = new Date()
const TODAY = isoDay()
const weekday = WEEKDAYS[NOW.getDay()]
const monthDay = `${NOW.getMonth() + 1}月${NOW.getDate()}日`

/** 环形进度与指标都按当前设备域的全量任务算（与 domainStats 口径一致）。 */
const stats = computed(() => domainStats(data.value))
const doneToday = computed(() => data.value.tasks.filter((t) => t.done && t.date === TODAY).length)
const pendingFocus = computed(() => todayTasks(data.value.tasks).filter((t) => t.status !== 'waiting').length)
const highPri = computed(() => todayTasks(data.value.tasks).filter((t) => t.pri === 'high').length)
const pendingSync = computed(() => data.value.tasks.filter((t) => t.sync && !t.done).length)
const onlineDevices = computed(() => DEVICES.filter((d) => d.online).length)
const sub = computed(() => `${weekday} · 今日 ${todayTasks(data.value.tasks).length} 项`)

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

const quickDevName = computed(
  () => DEVICES.find((d) => d.id === quickDev.value)?.name ?? '本机',
)

/** 设备域切换后，快速记录跟随当前域；详情抽屉也要收起（可能跨域找不到任务）。 */
watch(
  () => work.deviceId,
  (id) => {
    quickDev.value = id
    detailOpen.value = false
  },
)

function cycleQuickDev(): void {
  const idx = DEVICES.findIndex((d) => d.id === quickDev.value)
  const next = DEVICES[(idx + 1) % DEVICES.length]!
  quickDev.value = next.id
  haptic('light')
  toast(next.id === work.deviceId ? `快速记录 → ${next.name}` : `快速记录 → ${next.name}（保存时切域）`)
}

/** 保存后重新聚焦：手机键盘不该在每次回车后收起一次。 */
function keepFocus(): void {
  inputFocus.value = false
  setTimeout(() => { inputFocus.value = true }, 30)
}

function addQuick(): void {
  const title = quick.value.trim()
  if (title === '') {
    toast('先写一句要记的事')
    return
  }
  // 目标设备不是当前域时先切域，任务才会落进那台设备的数据里
  if (quickDev.value !== work.deviceId) switchDevice(quickDev.value)
  addTask(title, { date: TODAY, when: '今天', dev: deviceName() })
  quick.value = ''
  haptic('light')
  toast(`已记下 · ${deviceName()}`)
  keepFocus()
}

/* ── 清单 / 看板 / 筛选 ────────────────────────────────────────────── */

const taskView = ref<'list' | 'board'>('list')

type FilterMode = 'all' | 'high' | 'sub'
const filterMode = ref<FilterMode>('all')
const FILTER_LABEL: Record<FilterMode, string> = { all: '筛选', high: '高优先', sub: '有子待办' }

const collapsed = reactive<Record<TaskGroup, boolean>>({
  today: false,
  scheduled: false,
  inbox: false,
  done: false,
})

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
  const pick = (g: TaskGroup): Task[] => list.filter((t) => groupOf(t) === g)
  return [
    { key: 'today', label: '今天', icon: '✓', items: pick('today'), hint: '今天还没有安排 · 用上面输入框记一件' },
    { key: 'scheduled', label: '之后安排', icon: '▦', items: pick('scheduled'), hint: '没有排到其他日期的任务' },
    { key: 'inbox', label: '未排期', icon: '▤', items: pick('inbox'), hint: '收件箱是空的' },
    { key: 'done', label: '已完成', icon: '◷', items: pick('done'), hint: '还没有完成的任务' },
  ]
})

/** 空分组默认不占屏幕；只有「今天」空着时保留，用来提示去记录。 */
const visibleGroups = computed(() => groups.value.filter((g) => g.items.length > 0 || g.key === 'today'))

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

function setView(v: 'list' | 'board'): void {
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

function toggleGroup(key: TaskGroup): void {
  collapsed[key] = !collapsed[key]
  haptic('light')
}

/* ── 任务动作与详情 ────────────────────────────────────────────────── */

const detailOpen = ref(false)
const detailId = ref('')

function openTask(id: string): void {
  detailId.value = id
  detailOpen.value = true
  haptic('light')
}

function toggle(id: string): void {
  toggleTask(id)
  haptic('medium')
  const t = data.value.tasks.find((x) => x.id === id)
  toast(t?.done === true ? '已完成 · 待同步到 DSH' : '已恢复为未完成')
}

function subText(t: Task): string {
  const done = t.sub.filter((s) => s.done).length
  return `${done}/${t.sub.length}`
}

function isDue(t: Task): boolean {
  return /截止|逾期/.test(t.when)
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
          <text class="hdate">{{ monthDay }}</text>
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
          <view class="qadd" @tap="addQuick"><text class="qadd-g">＋</text></view>
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

      <!-- 清单 -->
      <view v-if="taskView === 'list'" class="groups">
        <view v-for="g in visibleGroups" :key="g.key" class="group">
          <view class="ghead" @tap="toggleGroup(g.key)">
            <view class="gi" :class="{ mut: g.key === 'done', warn: g.key === 'scheduled' }">
              <text>{{ g.icon }}</text>
            </view>
            <text class="gt">{{ g.label }}</text>
            <text class="mono gn">{{ g.items.length }}</text>
            <view class="sp" />
            <view class="chev" :class="{ up: collapsed[g.key] }" />
          </view>

          <view v-if="!collapsed[g.key]" class="gbody">
            <view
              v-for="t in g.items"
              :key="t.id"
              class="trow"
              :class="{ done: t.done, cur: detailOpen && detailId === t.id }"
              @tap="openTask(t.id)"
            >
              <view class="check" :class="{ on: t.done }" @tap.stop="toggle(t.id)">
                <text class="cg">✓</text>
              </view>
              <view class="tbody">
                <text class="tt">{{ t.title }}</text>
                <view
                  v-if="t.sub.length > 0 || t.tags.length > 0 || t.dev !== deviceName() || t.conflict || t.pri === 'high'"
                  class="tmeta"
                >
                  <text v-if="t.sub.length > 0" class="tmi mono">{{ subText(t) }}</text>
                  <text v-for="tag in t.tags" :key="tag" class="tmi">#{{ tag }}</text>
                  <text v-if="t.pri === 'high'" class="tmi high">高优先</text>
                  <text v-if="t.dev !== deviceName()" class="tmi dev">{{ t.dev }}</text>
                  <text v-if="t.conflict" class="tmi warn">冲突</text>
                </view>
              </view>
              <view class="tright">
                <text class="twhen mono" :class="{ due: isDue(t) }">{{ t.when }}</text>
                <view v-if="t.sync" class="syncdot" />
              </view>
            </view>
            <view v-if="g.items.length === 0" class="gempty">{{ g.hint }}</view>
          </view>
        </view>
      </view>

      <!-- 看板 -->
      <scroll-view v-else scroll-x class="board-scroll" :show-scrollbar="false">
        <view class="board">
          <view v-for="col in board" :key="col.key" class="bcol">
            <view class="bh">
              <view class="bdot" :class="col.key" />
              <text class="bt">{{ col.label }}</text>
              <text class="mono bn">{{ col.items.length }}</text>
            </view>
            <view v-for="t in col.items" :key="t.id" class="bcard" :class="t.pri" @tap="openTask(t.id)">
              <text class="bct">{{ t.title }}</text>
              <view class="bcm">
                <text class="bchip mono">{{ t.when }}</text>
                <text class="devbadge">{{ t.dev }}</text>
                <view v-if="t.sync" class="syncdot" />
              </view>
            </view>
            <view v-if="col.items.length === 0" class="bcol-empty">这一列暂时是空的</view>
          </view>
        </view>
      </scroll-view>
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
  padding: 0 14px;
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

.groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ghead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 8px;
}

.gi {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-size: 11px;
  color: var(--acc);
  background: var(--acc-soft);
}

.gi.mut { color: var(--t2); background: var(--s3); }
.gi.warn { color: var(--warn); background: var(--warn-soft); }

.gt {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--t3);
  text-transform: uppercase;
}

.gn {
  font-size: 9px;
  color: var(--t2);
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--s3);
}

.chev {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  margin-right: 3px;
  border-right: 1.5px solid var(--t3);
  border-bottom: 1.5px solid var(--t3);
  transform: rotate(45deg);
  transition: transform var(--t-mid) var(--ease-out);
}

.chev.up { transform: rotate(-45deg); }

.gbody {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.trow {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--s1);
  transition: background var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out);
}

.trow:active { background: var(--s2); }
.trow.cur { border-color: var(--bd-strong); }
.trow.done { opacity: 0.62; }

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

.check:active { transform: scale(0.9); }

.check.on {
  background: var(--acc);
  border-color: var(--acc);
  color: var(--acc-ink);
}

.cg { font-size: 12px; line-height: 1; }

.tbody { flex: 1; min-width: 0; }

.tt {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--t1);
  word-break: break-word;
}

.trow.done .tt {
  color: var(--t3);
  text-decoration: line-through;
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

.gempty {
  padding: 14px 10px 16px;
  text-align: center;
  font-size: 10.5px;
  line-height: 1.8;
  color: var(--t3);
  border: 1px dashed var(--bd);
  border-radius: var(--r-md);
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
  background: var(--acc);
}

.bdot.doing { background: var(--warn); }
.bdot.waiting { background: var(--t3); }

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
  padding: 14px 6px;
  text-align: center;
  font-size: 10px;
  color: var(--t3);
  border: 1px dashed var(--bd);
  border-radius: var(--r-sm);
}

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
