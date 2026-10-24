<script setup lang="ts">
/**
 * 专注屏：CSS 圆环倒计时 + 预设时长 + 任务选择 + 队列 + 今日统计。
 *
 * 计时用「结束时间戳」而不是每秒递减：
 *   App 切后台时 setInterval 会被节流，纯递减会越跑越慢；
 *   用 endsAt - Date.now() 每次重算，回前台第一帧就是正确值。
 *
 * 落账规则（M1 本地版）：
 *   - 走完一圈 → addFocus(taskId, 预设分钟, true)
 *   - 中途重置/换预设 → 已聚焦满 1 分钟才落 completed=false 的记录
 *   - 0 秒重置不写数据，避免统计里出现一堆 0 分钟记录
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { onHide } from '@dcloudio/uni-app'
import WorkShell from '@/components/WorkShell.vue'
import { addFocus, updateTask, useWork, domainStats } from '@/core/workbench'
import type { Task } from '@/core/workbench'
import { haptic } from '@/core/haptic'

const { data } = useWork()

type Phase = 'idle' | 'running' | 'paused' | 'done'

const PRESETS = [15, 25, 45, 60] as const
const presetMin = ref(25)
const leftSec = ref(presetMin.value * 60)
const phase = ref<Phase>('idle')
const pickerOpen = ref(false)
const focusTaskId = ref('')

let endsAt = 0
let tick: ReturnType<typeof setInterval> | undefined
/** 已为当前这一轮落过中断账：onHide + onUnmounted 可能连续触发，不能重复记账 */
let settled = false

const totalSec = computed(() => presetMin.value * 60)
const elapsedSec = computed(() => Math.max(0, totalSec.value - leftSec.value))
const ringDeg = computed(() => Math.min(360, (elapsedSec.value / totalSec.value) * 360))
const rightRingStyle = computed(() => ({ transform: `rotate(${180 + Math.min(180, ringDeg.value)}deg)` }))
const leftRingStyle = computed(() => ({ transform: `rotate(${180 + Math.max(0, ringDeg.value - 180)}deg)` }))

const clock = computed(() => {
  const s = leftSec.value
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
})

const phaseText = computed(() => {
  if (phase.value === 'running') return '专注中 · 别碰手机'
  if (phase.value === 'paused') return '已暂停'
  if (phase.value === 'done') return '本轮完成'
  return '准备开始'
})

const primaryLabel = computed(() => {
  if (phase.value === 'running') return '暂停'
  if (phase.value === 'paused') return '继续'
  if (phase.value === 'done') return '再来一轮'
  return '开始专注'
})

const subTitle = computed(() => {
  if (phase.value === 'running') return `${focusTask.value?.title ?? '自由专注'} · 专注中`
  return `${presetMin.value} 分钟 · 完成自动记账`
})

const openTasks = computed<Task[]>(() => data.value.tasks.filter((t) => !t.done))
const focusTask = computed<Task | null>(() => data.value.tasks.find((t) => t.id === focusTaskId.value) ?? null)
const queueTasks = computed(() => openTasks.value.slice(0, 4))
const totalStats = computed(() => domainStats(data.value))

const todayFocus = computed(() => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return data.value.focus.filter((f) => f.startedAt >= d.getTime())
})
const todayRounds = computed(() => todayFocus.value.filter((f) => f.completed).length)
const todayMinutes = computed(() => todayFocus.value.reduce((sum, f) => sum + f.minutes, 0))
const todayRate = computed(() => {
  const n = todayFocus.value.length
  if (n === 0) return 0
  return Math.round((todayRounds.value / n) * 100)
})

function toast(title: string): void {
  uni.showToast({ title, icon: 'none', duration: 1800 })
}

function stopTick(): void {
  if (tick !== undefined) {
    clearInterval(tick)
    tick = undefined
  }
}

function readLeft(): number {
  if (phase.value !== 'running') return leftSec.value
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
}

function startTick(): void {
  stopTick()
  tick = setInterval(() => {
    leftSec.value = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
    if (leftSec.value <= 0) finish()
  }, 250)
}

function finish(): void {
  stopTick()
  leftSec.value = 0
  phase.value = 'done'
  addFocus(focusTask.value?.id ?? '', presetMin.value, true)
  haptic('heavy')
  toast(`完成 ${presetMin.value} 分钟 · 已记入今日统计`)
}

/** 中断落账；返回落账分钟数（不足 1 分钟不落） */
function settleInterrupt(): number {
  if (phase.value !== 'running' && phase.value !== 'paused') return 0
  if (settled) return 0
  settled = true
  if (phase.value === 'running') leftSec.value = readLeft()
  stopTick()
  phase.value = 'paused'
  const minutes = Math.floor(elapsedSec.value / 60)
  if (minutes < 1) return 0
  addFocus(focusTask.value?.id ?? '', minutes, false)
  return minutes
}

function toggleRun(): void {
  haptic('light')
  if (phase.value === 'running') {
    leftSec.value = readLeft()
    stopTick()
    phase.value = 'paused'
    return
  }
  if (phase.value === 'paused') {
    settled = false
    endsAt = Date.now() + leftSec.value * 1000
    phase.value = 'running'
    startTick()
    return
  }
  settled = false
  leftSec.value = totalSec.value
  endsAt = Date.now() + leftSec.value * 1000
  phase.value = 'running'
  startTick()
}

function resetTimer(): void {
  haptic('light')
  const minutes = settleInterrupt()
  stopTick()
  phase.value = 'idle'
  leftSec.value = totalSec.value
  settled = false
  toast(minutes > 0 ? `已中断 · 记录 ${minutes} 分钟` : '已重置')
}

function applyPreset(minutes: number): void {
  if (minutes === presetMin.value && phase.value === 'idle') return
  haptic('light')
  const recorded = settleInterrupt()
  stopTick()
  presetMin.value = minutes
  phase.value = 'idle'
  leftSec.value = minutes * 60
  settled = false
  if (recorded > 0) toast(`已切到 ${minutes} 分钟 · 上一轮记录 ${recorded} 分钟`)
}

/**
 * 完成后直接把任务标记完成（专注 → 任务的唯一联动）。
 * 不自动置 done：专注 ≠ 任务完成，给用户一下明确的动作。
 */
function markTaskDone(): void {
  const t = focusTask.value
  if (t === null || t.done) return
  updateTask(t.id, { done: true })
  haptic('medium')
  toast(`已标记「${t.title}」完成`)
}

/* 离开页面/切后台时把已专注的部分落账，避免中断即丢；settleInterrupt 自身幂等 */
onHide(() => { settleInterrupt() })

function pickTask(id: string): void {
  haptic('light')
  focusTaskId.value = id
  pickerOpen.value = false
}

// 设备域切换 / 任务被勾完时，当前专注任务可能已不存在：回退到第一条待办
watch(
  data,
  () => {
    if (focusTask.value === null) focusTaskId.value = openTasks.value[0]?.id ?? ''
  },
  { immediate: true },
)

onUnmounted(() => {
  // 切 Tab 会销毁页面：中断也要落账，否则跑掉的时间在统计里凭空消失
  settleInterrupt()
  stopTick()
})
</script>

<template>
  <WorkShell active="focus" title="专注" :sub="subTitle">
    <view class="focus-page">
      <view class="focus-main">
        <!-- 计时区 -->
        <view class="timer-card">
          <text class="eyebrow">FOCUS / {{ presetMin }} MIN</text>
          <view class="ring">
            <view class="ring-half right"><view class="ring-rotor" :style="rightRingStyle" /></view>
            <view class="ring-half left"><view class="ring-rotor" :style="leftRingStyle" /></view>
            <view class="ring-hole">
              <text class="ring-time mono">{{ clock }}</text>
              <text class="ring-state" :class="{ live: phase === 'running', done: phase === 'done' }">{{ phaseText }}</text>
            </view>
          </view>

          <view class="presets">
            <view
              v-for="m in PRESETS"
              :key="m"
              class="preset fb-press"
              :class="{ on: presetMin === m }"
              @tap="applyPreset(m)"
            >
              <text class="preset-n mono">{{ m }}</text>
              <text class="preset-u">min</text>
            </view>
          </view>

          <view class="timer-btns">
            <view class="btn primary" @tap="toggleRun">{{ primaryLabel }}</view>
            <view class="btn" @tap="resetTimer">重置</view>
          </view>

          <view v-if="phase === 'done' && focusTask && !focusTask.done" class="done-row">
            <text class="done-t">这一轮是为了「{{ focusTask.title }}」</text>
            <view class="done-btn" @tap="markTaskDone"><text>标记任务完成</text></view>
          </view>

          <view class="task-pick" @tap="pickerOpen = true">
            <view class="dot" :class="{ off: focusTask === null }" />
            <view class="task-pick-main">
              <text class="task-cap">专注任务</text>
              <text class="task-name">{{ focusTask ? focusTask.title : '自由专注（不关联任务）' }}</text>
            </view>
            <text class="task-switch">切换</text>
          </view>
        </view>

        <!-- 队列 + 今日统计 -->
        <view class="side">
          <view class="sect">
            <text>专注队列</text>
            <text class="sect-n">{{ openTasks.length }} 条待专注</text>
          </view>

          <view v-if="queueTasks.length === 0" class="empty fb-empty">
            <text class="fb-empty-icon">◷</text>
            <text>点「开始专注」直接自由计时，或先去「今天」添加任务。</text>
          </view>
          <view
            v-for="(t, i) in queueTasks"
            :key="t.id"
            class="queue-item"
            :class="[{ on: t.id === focusTaskId }, `fb-stagger fb-i-${i}`]"
            @tap="pickTask(t.id)"
          >
            <text class="queue-n mono">{{ i + 1 }}</text>
            <view class="dot" :class="{ off: t.id !== focusTaskId }" />
            <text class="queue-t">{{ t.title }}</text>
            <text class="queue-when">{{ t.when }}</text>
          </view>

          <view class="sect">
            <text>今日专注统计</text>
            <text class="sect-n">本地 · 今日</text>
          </view>
          <view class="statgrid">
            <view class="statbox">
              <text class="stat-v mono">{{ todayRounds }}</text>
              <text class="stat-l">完成轮次</text>
            </view>
            <view class="statbox">
              <text class="stat-v mono">{{ todayMinutes }}</text>
              <text class="stat-l">专注分钟</text>
            </view>
            <view class="statbox">
              <text class="stat-v mono">{{ todayRate }}%</text>
              <text class="stat-l">完成率</text>
            </view>
          </view>
          <text class="cum mono">累计 {{ totalStats.focusRounds }} 轮 · {{ totalStats.focusMinutes }} 分钟</text>
        </view>
      </view>
    </view>

    <!-- 任务选择 -->
    <view v-if="pickerOpen" class="mask" @tap="pickerOpen = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-head">
          <text class="sheet-title">选择专注任务</text>
          <text class="sheet-x" @tap="pickerOpen = false">✕</text>
        </view>
        <scroll-view scroll-y class="sheet-list">
          <view class="pick-row" :class="{ on: focusTaskId === '' }" @tap="pickTask('')">
            <view class="dot" :class="{ off: focusTaskId !== '' }" />
            <view class="pick-main">
              <text class="pick-t">自由专注</text>
              <text class="pick-s">不关联任务，只记时间</text>
            </view>
          </view>
          <view
            v-for="t in openTasks"
            :key="t.id"
            class="pick-row"
            :class="{ on: t.id === focusTaskId }"
            @tap="pickTask(t.id)"
          >
            <view class="dot" :class="{ off: t.id !== focusTaskId }" />
            <view class="pick-main">
              <text class="pick-t">{{ t.title }}</text>
              <text class="pick-s">{{ t.when }}<text v-if="t.tags.length > 0"> · #{{ t.tags.join(' #') }}</text></text>
            </view>
            <text v-if="t.pri === 'high'" class="pick-pri">优先</text>
          </view>
          <view v-if="openTasks.length === 0" class="empty fb-empty">
            <text class="fb-empty-icon">◷</text>
            <text>选择「自由专注」，不用关联任务也能计时。</text>
          </view>
        </scroll-view>
      </view>
    </view>
  </WorkShell>
</template>

<style lang="scss" scoped>
.focus-page { padding-top: 2px; }

.focus-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.timer-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 14px 18px;
  background: var(--s1);
  border: 1px solid var(--bd);
  border-radius: var(--r-lg);
}
.eyebrow {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--t3);
}

.ring {
  position: relative;
  width: min(252px, 68vw);
  height: min(252px, 68vw);
  margin: 10px 0 4px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--s3);
  box-shadow: 0 0 34px var(--acc-soft);
}
.ring-half { position: absolute; top: 0; width: 50%; height: 100%; overflow: hidden; }
.ring-half.right { right: 0; }
.ring-half.left { left: 0; }
.ring-rotor {
  position: absolute;
  top: 0;
  width: 200%;
  height: 100%;
  border: 9px solid var(--acc);
  border-radius: 50%;
  transition: transform 250ms linear;
}
.ring-half.right .ring-rotor { left: -100%; }
.ring-half.left .ring-rotor { left: 0; }
.ring-hole {
  position: relative;
  z-index: 1;
  width: 82%;
  height: 82%;
  border-radius: 50%;
  background: var(--s1);
  box-shadow: inset 0 0 0 1px var(--bd);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.ring-time {
  font-size: clamp(38px, 10vw, 50px);
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1;
  color: var(--t1);
}
.ring-state {
  font-size: 10.5px;
  letter-spacing: 0.18em;
  color: var(--t3);
}
.ring-state.live { color: var(--acc); }
.ring-state.done { color: var(--ok); }

.presets {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 14px;
}
.preset {
  height: 34px;
  min-width: 60px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t2);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  transition: transform 90ms ease-out, background 160ms var(--ease-out), border-color 160ms var(--ease-out);
}
.preset:active { transform: scale(0.97); }
.preset.on {
  background: var(--acc-soft);
  border-color: var(--bd-strong);
  color: var(--acc);
}
.preset-n { font-size: 12px; font-weight: 600; }
.preset-u { font-size: 9px; color: var(--t3); }
.preset.on .preset-u { color: var(--acc); }

.timer-btns {
  display: flex;
  gap: 10px;
  width: 100%;
  max-width: 320px;
  margin-top: 14px;
}

.task-pick {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  margin-top: 16px;
  padding: 13px 14px;
  border-radius: var(--r-md);
  background: var(--s2);
  border: 1px solid var(--bd);
}
.task-pick:active { border-color: var(--bd-strong); }
.task-pick-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.task-cap {
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--t3);
}
.task-name {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--t1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.task-switch {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--acc);
  padding: 4px 9px;
  border-radius: 999px;
  background: var(--acc-soft);
  border: 1px solid var(--bd-strong);
}

.side { min-width: 0; margin-top: 14px; }
.sect {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1.4px;
  color: var(--t3);
  padding: 0 4px;
  margin: 18px 0 8px;
}
.side .sect:first-child { margin-top: 4px; }
.sect-n {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 10px;
  letter-spacing: 0;
  color: var(--t3);
}

.queue-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 13px;
  margin-bottom: 8px;
  border-radius: var(--r-md);
  background: var(--s1);
  border: 1px solid var(--bd);
  transition: border-color 160ms var(--ease-out), background 160ms var(--ease-out);
}
.queue-item:active { transform: scale(0.995); }
.queue-item.on {
  border-color: var(--bd-strong);
  background: var(--acc-soft);
}
.queue-n {
  width: 14px;
  flex: 0 0 14px;
  font-size: 10.5px;
  color: var(--t3);
  text-align: center;
}
.queue-t {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--t1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.queue-when {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--t3);
}

.statgrid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 9px;
}
.statbox {
  padding: 12px;
  border-radius: var(--r-md);
  background: var(--s1);
  border: 1px solid var(--bd);
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.stat-v {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--acc);
}
.stat-l {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--t3);
}
.cum {
  display: block;
  margin-top: 10px;
  padding: 0 4px;
  font-size: 10.5px;
  color: var(--t3);
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 18px 14px;
  border-radius: var(--r-md);
  border: 1px dashed var(--bd);
  font-size: 11.5px;
  line-height: 1.8;
  color: var(--t3);
}

/* 任务选择浮层 */
.mask {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: color-mix(in srgb, var(--bg) 76%, transparent);
}
.sheet {
  width: 100%;
  max-width: 560px;
  max-height: 74vh;
  display: flex;
  flex-direction: column;
  background: var(--s1);
  border: 1px solid var(--bd);
  border-radius: var(--r-lg) var(--r-lg) 0 0;
  padding: 16px 16px calc(18px + env(safe-area-inset-bottom));
}
.sheet-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
}
.sheet-title {
  flex: 1;
  font-size: 15px;
  font-weight: 700;
  color: var(--t1);
}
.sheet-x {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t2);
  font-size: 12px;
}
.sheet-list { max-height: 56vh; }
.pick-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 12px;
  margin-bottom: 8px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--s2);
}
.pick-row.on {
  border-color: var(--bd-strong);
  background: var(--acc-soft);
}
.pick-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.pick-t {
  font-size: 13px;
  font-weight: 600;
  color: var(--t1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.pick-s {
  font-size: 10.5px;
  color: var(--t3);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.pick-pri {
  flex: 0 0 auto;
  font-size: 9.5px;
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--warn);
  background: var(--warn-soft);
}

@media (min-width: 820px) {
  .focus-main {
    display: grid;
    grid-template-columns: minmax(320px, 430px) 1fr;
    gap: 10px 34px;
    align-items: start;
  }
  .timer-card { padding-top: 22px; }
  .side { margin-top: 0; }
  .side .sect:first-child { margin-top: 2px; }
  .mask { align-items: center; }
  .sheet {
    border-radius: var(--r-lg);
    padding-bottom: 18px;
  }
}
.done-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--r-md);
  background: var(--acc-soft);
  border: 1px solid var(--bd-strong);
}
.done-t { flex: 1; min-width: 0; font-size: 11.5px; color: var(--t2); }
.done-btn {
  flex: 0 0 auto;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  background: var(--acc);
  color: var(--acc-ink);
  font-size: 11.5px;
  font-weight: 600;
}
</style>
