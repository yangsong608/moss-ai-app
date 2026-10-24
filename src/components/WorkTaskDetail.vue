<script setup lang="ts">
/**
 * 任务详情抽屉（今天 / 日历两屏共用）。
 *
 * 为什么不各写一份：详情里的状态分段、优先级、日期、子待办、备注是**同一套写操作**，
 * 两屏各写一份必然出现"今天改了优先级、日历里还是旧值"这类只有真机才发现的漂移。
 * 所有写操作只走 @/core/workbench 的动作函数，组件自己不碰存储。
 *
 * 形态：手机底部抽屉（拇指可达）；平板上限宽 560 居中，不横跨整屏。
 * 图标一律文本字形 / CSS 形状——App 端内联 SVG 不稳。
 */
import { computed, ref, watch } from 'vue'
import {
  deviceName,
  isoDay,
  toggleSub,
  toggleTask,
  uid,
  updateTask,
  useWork,
  type Priority,
  type Task,
  type TaskStatus,
} from '@/core/workbench'
import { haptic } from '@/core/haptic'

const props = defineProps<{
  visible: boolean
  taskId: string
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { data } = useWork()

const found = computed<Task | undefined>(() => data.value.tasks.find((t) => t.id === props.taskId))

/** 任务可能在别的设备域里被清掉；给模板一个稳定对象，省掉每处 ?. */
const EMPTY: Task = {
  id: '', title: '', note: '', status: 'next', pri: 'normal', date: '', when: '',
  tags: [], sub: [], done: false, dev: '', sync: false, conflict: false, createdAt: 0, updatedAt: 0,
}
const t = computed<Task>(() => found.value ?? EMPTY)
const alive = computed(() => found.value !== undefined)

const todayIso = isoDay()
const titleDraft = ref('')
const noteDraft = ref('')
const subDraft = ref('')
/** 同快速记录：@confirm 与最后一击 input 的先后顺序不可靠，用 key 重建输入框清空更稳。 */
const subKey = ref(0)

/** 只在"打开 / 换任务"时灌草稿：跟随每次任务改动会把正在输入的备注冲掉。 */
watch(
  () => [props.visible, props.taskId] as const,
  ([vis]) => {
    if (!vis) return
    titleDraft.value = t.value.title
    noteDraft.value = t.value.note
    subDraft.value = ''
  },
  { immediate: true },
)

const STATUS: { key: TaskStatus; label: string }[] = [
  { key: 'next', label: '下一步' },
  { key: 'doing', label: '进行中' },
  { key: 'waiting', label: '等待中' },
]

const PRIS: { key: Priority; label: string }[] = [
  { key: 'high', label: '高' },
  { key: 'normal', label: '中' },
  { key: 'low', label: '低' },
]

const subDone = computed(() => t.value.sub.filter((s) => s.done).length)

const dateLabel = computed(() => {
  const d = t.value.date
  if (d === '') return '未排期'
  if (d === todayIso) return '今天'
  return md(d)
})

function md(iso: string): string {
  const parts = iso.split('-')
  return `${Number(parts[1])}月${Number(parts[2])}日`
}

function toast(title: string): void {
  uni.showToast({ title, icon: 'none' })
}

function close(): void {
  emit('close')
}

/* ── 标题 / 备注 ───────────────────────────────────────────────────── */

/**
 * 读事件里的值而不是只读 ref：uni-app 的 @confirm 在最后一击时可能比 v-model 早一帧，
 * 直接读 quick.value / titleDraft.value 会丢掉最后输入的那个字（实测真会）。
 */
function fieldValue(e: any, fallback: string): string {
  const raw = e?.detail?.value
  return typeof raw === 'string' ? raw : fallback
}

function commitTitle(e?: any): void {
  if (!alive.value) return
  const next = fieldValue(e, titleDraft.value).trim()
  titleDraft.value = next
  if (next === '') {
    titleDraft.value = t.value.title
    return
  }
  if (next === t.value.title) return
  updateTask(props.taskId, { title: next })
  haptic('light')
  toast('标题已更新 · 待同步')
}

function commitNote(e?: any): void {
  if (!alive.value) return
  const next = fieldValue(e, noteDraft.value)
  noteDraft.value = next
  if (next === t.value.note) return
  updateTask(props.taskId, { note: next })
  toast('备注已存本机')
}

/* ── 状态 / 优先级 / 日期 ──────────────────────────────────────────── */

function pickStatus(s: TaskStatus): void {
  if (!alive.value || t.value.status === s) return
  updateTask(props.taskId, { status: s })
  haptic('light')
  const label = STATUS.find((x) => x.key === s)?.label ?? s
  toast(`状态已改为「${label}」`)
}

function pickPri(p: Priority): void {
  if (!alive.value || t.value.pri === p) return
  updateTask(props.taskId, { pri: p })
  haptic('light')
  const label = PRIS.find((x) => x.key === p)?.label ?? p
  toast(`优先级已设为 ${label}`)
}

/**
 * 改日期时 `when` 的处理：
 *   - 时间型（9:30）保留时间，只挪日期
 *   - 文字型（今天 / 未排期 / 截止周五）换成新的日期文字
 * 否则改期后行上还写着"截止周五"，用户会以为没生效。
 */
function applyDate(next: string): void {
  if (!alive.value) return
  const cur = t.value
  // 带具体时间的任务改到哪天都保留时间；否则整条会从日历网格里消失
  const timed = /^\d{1,2}:\d{2}$/.test(cur.when)
  const when = timed ? cur.when : next === todayIso ? '今天' : md(next)
  updateTask(cur.id, { date: next, when })
  haptic('light')
  toast(`日期已改为 ${next === todayIso ? '今天' : md(next)}`)
}

function onPickDate(e: any): void {
  const v = String(e?.detail?.value ?? '')
  if (v !== '') applyDate(v)
}

function setTomorrow(): void {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  applyDate(isoDay(d))
}

function clearDate(): void {
  if (!alive.value) return
  updateTask(t.value.id, { date: '', when: '未排期' })
  haptic('light')
  toast('已移出排期')
}

/* ── 子待办 ────────────────────────────────────────────────────────── */

function onSubToggle(subId: string): void {
  if (!alive.value) return
  toggleSub(props.taskId, subId)
  haptic('light')
}

function addSub(e?: any): void {
  const v = fieldValue(e, subDraft.value).trim()
  if (!alive.value || v === '') return
  updateTask(props.taskId, { sub: [...t.value.sub, { id: uid(), title: v, done: false }] })
  subDraft.value = ''
  subKey.value += 1
  haptic('light')
  toast('已加子待办')
}

function removeSub(subId: string): void {
  if (!alive.value) return
  updateTask(props.taskId, { sub: t.value.sub.filter((s) => s.id !== subId) })
  haptic('light')
  toast('已删掉这个子待办')
}

/* ── 完成 / AI 占位 ────────────────────────────────────────────────── */

function onToggleDone(): void {
  if (!alive.value) return
  toggleTask(props.taskId)
  haptic('medium')
  toast(t.value.done ? '已完成 · 待同步到 DSH' : '已恢复为未完成')
}

function aiSplit(): void {
  haptic('light')
  uni.showToast({
    title: 'AI 拆解将在 M2 接入；现在可以先把子待办手写下来',
    icon: 'none',
    duration: 2400,
  })
}
</script>

<template>
  <view v-if="props.visible" class="mask" @tap="close">
    <view class="sheet" @tap.stop>
      <view class="grab" />

      <view class="head">
        <text class="kicker mono">任务详情</text>
        <view class="x" @tap="close"><text class="xg">✕</text></view>
      </view>

      <scroll-view scroll-y class="body">
        <view v-if="!alive" class="gone">这条任务已不在当前设备域。</view>

        <view v-else class="dtl">
          <input
            v-model="titleDraft"
            class="dt-title"
            :maxlength="80"
            @blur="commitTitle"
            @confirm="commitTitle"
          />
          <text class="dt-hint">点标题直接改 · 失焦存本机</text>

          <view class="tagline">
            <text v-for="tag in t.tags" :key="tag" class="tag">#{{ tag }}</text>
            <text class="devbadge" :class="{ me: t.dev === deviceName() }">{{ t.dev }}</text>
            <text class="pill" :class="t.sync ? 'wait' : 'mut'">{{ t.sync ? '待同步' : '已同步' }}</text>
          </view>

          <!-- 状态 / 优先级 / 日期 -->
          <view class="ctl">
            <view class="cr">
              <text class="cl">状态</text>
              <view class="seg-mini">
                <view
                  v-for="s in STATUS"
                  :key="s.key"
                  class="sb"
                  :class="{ on: t.status === s.key }"
                  @tap="pickStatus(s.key)"
                >
                  <text>{{ s.label }}</text>
                </view>
              </view>
            </view>

            <view class="cr">
              <text class="cl">优先级</text>
              <view class="pripick">
                <view
                  v-for="p in PRIS"
                  :key="p.key"
                  class="pribtn"
                  :class="{ on: t.pri === p.key }"
                  @tap="pickPri(p.key)"
                >
                  <view class="pridot" :class="p.key" />
                  <text>{{ p.label }}</text>
                </view>
              </view>
            </view>

            <view class="cr date-cr">
              <text class="cl">日期</text>
              <picker mode="date" :value="t.date || todayIso" @change="onPickDate">
                <view class="datechip mono">
                  <text class="dcg">▦</text>
                  <text>{{ dateLabel }}</text>
                </view>
              </picker>
              <view class="minibtn" @tap="setTomorrow"><text>明天</text></view>
              <view class="minibtn" :class="{ on: t.date === '' }" @tap="clearDate"><text>未排期</text></view>
            </view>
          </view>

          <!-- 子待办 -->
          <view class="sect">
            <text class="st">子待办</text>
            <text class="mono sn">{{ subDone }}/{{ t.sub.length }}</text>
            <view class="line" />
          </view>
          <view class="subs">
            <view
              v-for="s in t.sub"
              :key="s.id"
              class="sub"
              :class="{ done: s.done }"
              @tap="onSubToggle(s.id)"
            >
              <view class="sc" :class="{ on: s.done }"><text class="sg">✓</text></view>
              <text class="sub-t">{{ s.title }}</text>
              <view class="sub-x" @tap.stop="removeSub(s.id)"><text>✕</text></view>
            </view>

            <view class="subadd">
              <view class="plus"><text>＋</text></view>
              <input
                :key="subKey"
                v-model="subDraft"
                class="subin"
                placeholder="添加子待办，回车保存"
                placeholder-class="ph"
                :maxlength="80"
                @confirm="addSub"
              />
              <view class="subgo" @tap="addSub"><text>＋</text></view>
            </view>
          </view>

          <!-- 备注 -->
          <view class="sect">
            <text class="st">备注</text>
            <view class="line" />
          </view>
          <textarea
            v-model="noteDraft"
            class="note"
            auto-height
            :maxlength="500"
            placeholder="补几笔要点…（失焦自动保存）"
            placeholder-class="ph"
            @blur="commitNote"
          />

          <view class="actions">
            <view class="abtn primary" @tap="aiSplit"><text>让 AI 拆解</text></view>
            <view class="abtn" @tap="onToggleDone"><text>{{ t.done ? '恢复未完成' : '标记完成' }}</text></view>
          </view>
          <text class="ai-desc">「让 AI 拆解」会把任务拆成可执行子步骤并回写本机；笔记本与标签不动。M1 先做占位提示。</text>
        </view>
      </scroll-view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: color-mix(in srgb, var(--bg-grad-3) 72%, transparent);
  animation: mask-in 160ms var(--ease-out);
}

@keyframes mask-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.sheet {
  width: 100%;
  max-width: 560px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  background: var(--s1);
  border: 1px solid var(--bd-strong);
  border-bottom: 0;
  border-top-left-radius: 18px;
  border-top-right-radius: 18px;
  padding-bottom: calc(6px + var(--safe-bottom-real, 0px));
  animation: sheet-up var(--t-mid) var(--ease-out);
}

@keyframes sheet-up {
  from { transform: translateY(22px); opacity: 0.6; }
  to { transform: translateY(0); opacity: 1; }
}

.grab {
  width: 38px;
  height: 4px;
  border-radius: 4px;
  background: var(--s3);
  margin: 8px auto 2px;
  flex: 0 0 auto;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px 2px;
  flex: 0 0 auto;
}

.kicker {
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.14em;
  color: var(--t3);
  text-transform: uppercase;
}

.x {
  margin-left: auto;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: var(--s2);
  border: 1px solid var(--bd);
  color: var(--t2);
}

.x:active { color: var(--t1); background: var(--s3); }
.xg { font-size: 12px; line-height: 1; }

.body {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 72vh;
  padding: 4px 16px 12px;
}

.gone {
  padding: 36px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--t3);
}

/* ── 标题与标签 ─────────────────────────────────────────────────── */

.dt-title {
  width: 100%;
  height: 40px;
  font-size: 17px;
  font-weight: 700;
  color: var(--t1);
  background: transparent;
  padding: 0 7px;
  margin: 0 -7px;
  border-radius: 9px;
}

.dt-title:focus {
  background: var(--s2);
  box-shadow: 0 0 0 1.5px var(--bd-strong);
}

.dt-hint {
  display: block;
  font-size: 9.5px;
  color: var(--t3);
  margin: 1px 0 0;
  letter-spacing: 0.04em;
}

.tagline {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 10px 0 2px;
}

.tag {
  font-size: 9.5px;
  color: var(--acc);
  background: var(--acc-soft);
  padding: 3px 7px;
  border-radius: 5px;
}

.devbadge {
  font-size: 9.5px;
  color: var(--t2);
  background: var(--s3);
  border: 1px solid var(--bd);
  padding: 3px 7px;
  border-radius: 5px;
}

.devbadge.me {
  color: var(--acc);
  background: var(--acc-soft);
  border-color: transparent;
}

.pill {
  font-size: 9.5px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 999px;
}

.pill.wait { color: var(--warn); background: var(--warn-soft); }
.pill.mut { color: var(--t3); background: var(--s3); }

/* ── 控件区 ─────────────────────────────────────────────────────── */

.ctl {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
  padding: 12px;
  border-radius: var(--r-md);
  background: var(--s2);
  border: 1px solid var(--bd);
}

.cr {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cl {
  flex: 0 0 42px;
  font-size: 9px;
  letter-spacing: 0.12em;
  color: var(--t3);
}

.seg-mini {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 10px;
  background: var(--s3);
  border: 1px solid var(--bd);
}

.sb {
  height: 25px;
  padding: 0 11px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--t3);
}

.sb.on {
  background: var(--s1);
  color: var(--acc);
  box-shadow: inset 0 0 0 1px var(--bd);
}

.pripick { display: flex; gap: 6px; }

.pribtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--bd);
  color: var(--t3);
  font-size: 11px;
}

.pribtn.on {
  border-color: var(--bd-strong);
  background: var(--s3);
  color: var(--t1);
  font-weight: 600;
}

.pridot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--acc);
}

.pridot.high { background: var(--danger); }
.pridot.low { background: var(--t3); }

.date-cr { gap: 6px; }

.datechip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--bd);
  background: var(--s3);
  color: var(--t1);
  font-size: 10.5px;
}

.dcg { font-size: 10px; color: var(--t3); }

.minibtn {
  height: 26px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--bd);
  color: var(--t3);
  font-size: 10px;
  display: flex;
  align-items: center;
}

.minibtn.on { color: var(--acc); border-color: var(--bd-strong); background: var(--acc-soft); }

/* ── 分段标题 ───────────────────────────────────────────────────── */

.sect {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 16px 0 7px;
}

.st {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--t3);
  text-transform: uppercase;
}

.sn { font-size: 9.5px; color: var(--t3); }
.line { flex: 1; height: 1px; background: var(--bd); }

/* ── 子待办 ─────────────────────────────────────────────────────── */

.subs { display: flex; flex-direction: column; }

.sub {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 4px;
  border-radius: 9px;
}

.sub:active { background: var(--s2); }

.sc {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  border-radius: 6px;
  border: 1.5px solid var(--bd-strong);
  display: grid;
  place-items: center;
  color: transparent;
}

.sc.on {
  background: var(--acc);
  border-color: var(--acc);
  color: var(--acc-ink);
}

.sg { font-size: 10px; line-height: 1; }

.sub-t {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--t1);
}

.sub.done .sub-t {
  color: var(--t3);
  text-decoration: line-through;
}

.sub-x {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  display: grid;
  place-items: center;
  color: var(--t3);
  font-size: 10px;
}

.subadd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
}

.plus {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  border-radius: 6px;
  border: 1.5px dashed var(--bd-strong);
  display: grid;
  place-items: center;
  color: var(--t3);
  font-size: 10px;
}

.subin {
  flex: 1;
  min-width: 0;
  height: 34px;
  border-radius: 9px;
  border: 1px dashed var(--bd);
  background: transparent;
  color: var(--t1);
  padding: 0 10px;
  font-size: 12px;
}

.subin:focus { border-style: solid; border-color: var(--bd-strong); }

.subgo {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  border-radius: 8px;
  background: var(--acc);
  color: var(--acc-ink);
  display: grid;
  place-items: center;
  font-size: 15px;
}

/* ── 备注与动作 ─────────────────────────────────────────────────── */

.note {
  width: 100%;
  min-height: 78px;
  border-radius: var(--r-sm);
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t2);
  font-size: 12px;
  line-height: 1.8;
  padding: 10px 11px;
}

.note:focus { border-color: var(--bd-strong); color: var(--t1); }

.actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

.abtn {
  flex: 1;
  height: 44px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t2);
  display: grid;
  place-items: center;
  font-size: 12.5px;
  font-weight: 600;
}

.abtn.primary {
  flex: 1.4;
  background: var(--acc);
  border-color: transparent;
  color: var(--acc-ink);
}

.abtn:active { transform: scale(0.98); }

.ai-desc {
  display: block;
  font-size: 10px;
  line-height: 1.7;
  color: var(--t3);
  margin: 8px 2px 4px;
}

.ph { color: var(--t3); }

@media (min-width: 820px) {
  .sheet { max-height: 82vh; }
  .body { max-height: 68vh; }
}
</style>
