<script setup lang="ts">
/**
 * 整页笔记编辑器。
 *
 * 从笔记列表的阅读态点「编辑」进入（`/pages/note-edit/note-edit?id=xxx`），
 * 独立于 WorkShell：全屏、无底部 Tab，专注写这一篇。
 *
 * 交互：
 *   - 顶部：返回 / 保存状态 / 收藏 / 「预览 · 编辑」切换
 *   - 标题 input 与正文 textarea；插入符停在哪就写哪，600ms 防抖自动保存
 *   - 底部工具条：AI 完善、按要求完善、问 AI、移动到笔记本、删除（二次确认）
 *
 * 为什么把编辑器搬出 notes.vue：
 *   手机上一屏同时塞列表 + 编辑器时，键盘弹起后正文只剩三行；
 *   整页后标题、正文、工具条各有固定位置，且返回列表时阅读态能直接看到结果。
 */
import { computed, onUnmounted, reactive, ref } from 'vue'
import { onLoad, onUnload } from '@dcloudio/uni-app'
import MossMarkdown from '@/components/MossMarkdown.vue'
import MossSheet, { type SheetItem } from '@/components/MossSheet.vue'
import {
  addNotebook,
  deviceName,
  isoDay,
  moveNote,
  removeNote,
  updateNote,
  useWork,
} from '@/core/workbench'
import type { Note } from '@/core/workbench'
import { skinClass, themeClass } from '@/core/store'
import { haptic } from '@/core/haptic'
import { stashContext } from '@/core/ai-context'
import { dispatchNotePolish, liveAiHost } from '@/core/ai-dispatch'
import type { DispatchOutcome } from '@/core/ai-dispatch'

const { data } = useWork()

const noteId = ref('')
const draftTitle = ref('')
const draftBody = ref('')
/** 阅读态 / 编辑态：进入默认编辑，`preview=1` 可直接以预览打开 */
const mode = ref<'edit' | 'preview'>('edit')
const saveState = ref<'saved' | 'dirty'>('saved')

/**
 * AI 派发页面态（自 notes.vue 迁移）：
 *   - aiBusy：派发中/等待回写，按钮置灰避免重复派发；
 *   - aiHint：常驻一行状态（成功/超时/降级），比一闪而过的 toast 更耐读；
 *   - aiWarn：降级或失败用警示色；
 *   - aiStop：离开页面时置 true，轮询最多再等一个 tick。
 */
const aiBusy = ref(false)
const aiHint = ref('')
const aiWarn = ref(false)
let aiStop = false

let saveTimer: ReturnType<typeof setTimeout> | undefined

const rootClass = computed(() => ['dsh', 'ne', skinClass.value, themeClass.value])
const activeNote = computed<Note | null>(() => data.value.notes.find((n) => n.id === noteId.value) ?? null)
/** id 缺失（直接打开路由）或笔记被删除时，给一个可退出的空态，而不是空白页 */
const missing = computed(() => noteId.value === '' || activeNote.value === null)
const isFav = computed(() => activeNote.value?.fav === true)
const noteNotebook = computed(() => activeNote.value?.notebook ?? '未分类')
const noteTime = computed(() => (activeNote.value === null ? '' : timeLabel(activeNote.value.updatedAt)))
const wordCount = computed(() => draftBody.value.replace(/\s+/g, '').length)
const saveLabel = computed(() => (saveState.value === 'saved' ? '已保存 · 本地' : '待保存…'))

/* ─────────── 弹层（菜单 / 确认 / 输入一套控制器） ─────────── */

interface SheetState {
  visible: boolean
  kind: 'menu' | 'confirm' | 'prompt' | 'info'
  title: string
  message: string
  items: SheetItem[]
  value: string
  placeholder: string
  confirmText: string
  onSelect?: (index: number) => void
  onConfirm?: (text: string) => void
}

const sheet = reactive<SheetState>({
  visible: false,
  kind: 'menu',
  title: '',
  message: '',
  items: [],
  value: '',
  placeholder: '',
  confirmText: '确定',
})

function openSheet(next: Partial<SheetState>): void {
  Object.assign(
    sheet,
    {
      kind: 'menu',
      title: '',
      message: '',
      items: [],
      value: '',
      placeholder: '',
      confirmText: '确定',
      onSelect: undefined,
      onConfirm: undefined,
    },
    next,
    { visible: true },
  )
}

function closeSheet(): void {
  sheet.visible = false
}

/** MossSheet 自己会先关再 emit：这里只负责把回调取出来执行，顺序不能反。 */
function onSheetSelect(index: number): void {
  const cb = sheet.onSelect
  closeSheet()
  cb?.(index)
}

function onSheetConfirm(text: string): void {
  const cb = sheet.onConfirm
  closeSheet()
  cb?.(text)
}

/* ─────────── 保存 ─────────── */

function toast(title: string): void {
  uni.showToast({ title, icon: 'none', duration: 1800 })
}

function flush(): void {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  if (missing.value) {
    saveState.value = 'saved'
    return
  }
  const note = activeNote.value
  if (note === null) return
  if (note.title === draftTitle.value && note.content === draftBody.value) {
    saveState.value = 'saved'
    return
  }
  updateNote(note.id, { title: draftTitle.value, content: draftBody.value })
  saveState.value = 'saved'
}

function scheduleSave(): void {
  saveState.value = 'dirty'
  if (saveTimer !== undefined) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    flush()
  }, 600)
}

/** 把 store 里的最新内容拉回草稿（AI 回写、外部同步后调用） */
function loadFresh(): void {
  const note = activeNote.value
  if (note === null) return
  draftTitle.value = note.title
  draftBody.value = note.content
  saveState.value = 'saved'
}

function timeLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (isoDay(d) === isoDay(now)) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const diff = Math.floor((now.getTime() - ts) / 86_400_000)
  if (diff === 1) return '昨天'
  if (diff > 1 && diff < 7) return `${diff} 天前`
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/* ─────────── 导航与模式 ─────────── */

function back(): void {
  flush()
  haptic('light')
  // 深链/刷新进来的页面栈里没有上一页：兜底回笔记列表
  uni.navigateBack({
    fail: () => {
      uni.reLaunch({ url: '/pages/notes/notes' })
    },
  })
}

function goNotes(): void {
  flush()
  haptic('light')
  uni.reLaunch({ url: '/pages/notes/notes' })
}

function setMode(next: 'edit' | 'preview'): void {
  if (mode.value === next) return
  // 先进预览要先落盘：否则看到的是 600ms 防抖之前的旧正文
  if (next === 'preview') flush()
  mode.value = next
  haptic('light')
}

function toggleFav(): void {
  const note = activeNote.value
  if (note === null) return
  haptic('light')
  updateNote(note.id, { fav: !note.fav })
}

/* ─────────── 移动到笔记本 ─────────── */

function applyMove(notebook: string): void {
  if (noteId.value === '') return
  moveNote(noteId.value, notebook)
  haptic('medium')
  toast(`已移动到「${notebook}」`)
}

function openMove(): void {
  const note = activeNote.value
  if (note === null) return
  haptic('light')
  const names = data.value.notebooks.map((n) => n.name)
  // 同步来的笔记可能指向清单外的名字：并集展示，避免"看起来没地方可移"
  if (!names.includes(note.notebook)) names.unshift(note.notebook)
  const items: SheetItem[] = names.map((name) => ({
    label: name,
    hint: name === note.notebook ? '当前笔记本' : '移动过去',
  }))
  items.push({ label: '＋ 新建笔记本', hint: '创建后把这篇移过去' })
  openSheet({
    kind: 'menu',
    title: '移动到笔记本',
    items,
    onSelect: (index) => {
      if (index < names.length) {
        applyMove(names[index] as string)
        return
      }
      openSheet({
        kind: 'prompt',
        title: '新建笔记本',
        message: '给笔记本取个名字，这篇笔记会移过去。',
        placeholder: '例如：项目 A',
        confirmText: '创建并移动',
        onConfirm: (text) => {
          const nb = addNotebook(text)
          if (nb === undefined) {
            toast('请先填写笔记本名称')
            return
          }
          applyMove(nb.name)
        },
      })
    },
  })
}

/* ─────────── 删除（二次确认） ─────────── */

function confirmDelete(): void {
  const note = activeNote.value
  if (note === null) return
  haptic('light')
  openSheet({
    kind: 'confirm',
    title: '删除这篇笔记？',
    message: `「${note.title || '未命名笔记'}」删除后不可恢复（当前没有回收站）。`,
    confirmText: '删除',
    onConfirm: () => {
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer)
        saveTimer = undefined
      }
      removeNote(note.id)
      haptic('medium')
      toast('已删除')
      uni.navigateBack({
        fail: () => {
          uni.reLaunch({ url: '/pages/notes/notes' })
        },
      })
    },
  })
}

/* ─────────── AI（沿用 ai-dispatch / ai-context，不改协议层） ─────────── */

/**
 * AI 完善：经设备上的 DSH agent 回写这篇笔记。
 *
 * 流程全在 `ai-dispatch.ts`：syncNow 推一轮 → workspace.list → session.create →
 * session.prompt（指令带笔记 id 与 workbench_note_update 硬要求）→ 每 5s 同步，
 * 最多 12 次，等这篇笔记的 updatedAt 变化。离线/caps 不支持降级为弹窗说明。
 */
async function runPolish(extra: string): Promise<void> {
  if (aiBusy.value) return
  const note = activeNote.value
  if (note === null) return
  // 先落盘再派发：否则 agent 读到的是 600ms 防抖之前的旧正文
  flush()
  const fresh = data.value.notes.find((n) => n.id === note.id)
  if (fresh === undefined) return
  haptic('light')
  aiBusy.value = true
  aiWarn.value = false
  aiHint.value = `正在派发给「${deviceName()}」执行…`
  aiStop = false
  const requirement = extra.trim()
  try {
    const host = await liveAiHost()
    const outcome = await dispatchNotePolish(
      host,
      {
        noteId: fresh.id,
        title: draftTitle.value || fresh.title,
        notebook: fresh.notebook,
        ...(requirement === '' ? {} : { extra: requirement }),
      },
      { shouldStop: () => aiStop },
    )
    applyAiOutcome(outcome)
  } catch (error) {
    aiWarn.value = true
    aiHint.value = '派发失败：连接层不可用，内容只在本机保存。'
    uni.showModal({
      title: 'AI 完善失败',
      content: `${aiHint.value}\n\n${error instanceof Error ? error.message : String(error)}`,
      showCancel: false,
      confirmText: '知道了',
    })
  } finally {
    aiBusy.value = false
  }
}

/** 手机端没有后台任务列表，结果必须"落"在页面上：成功刷新草稿，其余说明原因。 */
function applyAiOutcome(outcome: DispatchOutcome): void {
  aiWarn.value = outcome.status !== 'done'
  aiHint.value = outcome.message
  if (outcome.status === 'done') {
    // 拉回来的新正文要立刻进编辑器，否则下一次 flush 会把 AI 的结果覆盖回去
    loadFresh()
    haptic('medium')
    toast('AI 已回写并同步')
    return
  }
  if (outcome.status === 'cancelled') return
  if (outcome.status === 'timeout') {
    uni.showToast({ title: '已在设备上执行，稍后自动同步', icon: 'none', duration: 2800 })
    return
  }
  const title = outcome.status === 'degraded'
    ? (outcome.code === 'no-workbench' ? '设备不支持 AI 回写' : '需要连接设备')
    : 'AI 完善失败'
  uni.showModal({ title, content: outcome.message, showCancel: false, confirmText: '知道了' })
}

function aiPolish(): void {
  void runPolish('')
}

/** 「按要求完善」：追加一句要求（如"压缩到 300 字"），其余流程与 AI 完善一致。 */
function aiPolishWithRequirement(): void {
  if (aiBusy.value) return
  if (activeNote.value === null) return
  uni.showModal({
    title: '按要求完善',
    editable: true,
    placeholderText: '例如：压缩到 300 字，并补一节风险',
    confirmText: '派发',
    cancelText: '取消',
    success: (res) => {
      if (!res.confirm) return
      const extra = typeof res.content === 'string' ? res.content.trim() : ''
      if (extra === '') toast('没有填写要求，按默认方式完善')
      void runPolish(extra)
    },
  })
}

/**
 * 问 AI：把当前笔记的标题/正文摘要暂存到上下文槽，跳对话页预填。
 *
 * 先 flush()：用户可能刚敲完还没到 600ms 防抖，直接读 store 会带旧正文过去。
 * 摘要去掉 Markdown 标记并压成单行（输入框是单行，换行会被吃掉）。
 */
function askAi(): void {
  const note = activeNote.value
  if (note === null) return
  flush()
  haptic('light')
  const excerpt = draftBody.value
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  stashContext({
    kind: 'note',
    id: note.id,
    title: draftTitle.value.trim() === '' ? '未命名笔记' : draftTitle.value,
    excerpt,
  })
  uni.navigateTo({ url: '/pages/chat/chat?from=workbench' })
}

/* ─────────── 生命周期 ─────────── */

onLoad((q) => {
  const id = q !== undefined && typeof q['id'] === 'string' ? q['id'] : ''
  noteId.value = id
  const note = data.value.notes.find((n) => n.id === id)
  if (note === undefined) return
  draftTitle.value = note.title
  draftBody.value = note.content
  if (q !== undefined && q['preview'] === '1') mode.value = 'preview'
})

// 页面出栈（返回/被关）先落盘；onUnloaded 在某些平台不触发，双保险
onUnload(() => {
  flush()
  aiStop = true
})

onUnmounted(() => {
  flush()
  if (saveTimer !== undefined) clearTimeout(saveTimer)
  // 离开页面后不再等设备回写：轮询下一个 tick 就退出（任务本身在设备上继续跑）
  aiStop = true
})
</script>

<template>
  <view :class="rootClass">
    <!-- 顶部：返回 / 保存状态 / 收藏 / 预览·编辑 -->
    <view class="ne-top safe-top">
      <view class="ne-back" @tap="back"><text>‹</text></view>
      <text v-if="!missing" class="ne-save" :class="saveState">{{ saveLabel }}</text>
      <text v-else class="ne-save">笔记</text>
      <view class="sp" />
      <view v-if="!missing" class="ne-star" :class="{ on: isFav }" @tap="toggleFav">
        <text>{{ isFav ? '★' : '☆' }}</text>
      </view>
      <view v-if="!missing" class="seg">
        <view class="seg-i" :class="{ on: mode === 'preview' }" @tap="setMode('preview')">
          <text>预览</text>
        </view>
        <view class="seg-i" :class="{ on: mode === 'edit' }" @tap="setMode('edit')">
          <text>编辑</text>
        </view>
      </view>
    </view>

    <!-- 笔记不存在：id 缺失 / 已删除 / 不在当前设备域 -->
    <view v-if="missing" class="ne-miss">
      <text class="miss-title">笔记不存在或已删除</text>
      <text class="miss-sub">可能已不在当前设备域，或被其它端删除。</text>
      <view class="btn primary miss-btn" @tap="goNotes"><text>返回笔记列表</text></view>
    </view>

    <template v-else>
      <input
        v-model="draftTitle"
        class="ne-title"
        placeholder="标题…"
        placeholder-style="color: var(--t3)"
        :maxlength="-1"
        @input="scheduleSave"
      />

      <view class="ne-meta">
        <text class="nb-tag">{{ noteNotebook }}</text>
        <text class="ne-time mono">{{ noteTime }}</text>
        <text class="ne-wc mono">{{ wordCount }} 字</text>
      </view>

      <!-- 预览：整页渲染 Markdown（复用 MossMarkdown，按块渲染，不拼 HTML） -->
      <scroll-view v-if="mode === 'preview'" scroll-y class="ne-scroll">
        <view class="ne-preview">
          <MossMarkdown v-if="draftBody.trim().length > 0" :text="draftBody" />
          <view v-else class="ne-empty"><text>空白笔记 · 切到「编辑」开始写</text></view>
        </view>
      </scroll-view>

      <textarea
        v-else
        v-model="draftBody"
        class="ne-body"
        placeholder="开始写… 支持 Markdown 习惯的纯文本"
        placeholder-style="color: var(--t3)"
        :maxlength="-1"
        :show-confirm-bar="false"
        @input="scheduleSave"
        @blur="flush"
      ></textarea>

      <!-- 常驻状态行：成功/等待/降级都写在这里，不依赖一闪而过的 toast -->
      <view v-if="aiHint !== ''" class="ai-hint" :class="{ bad: aiWarn }">
        <text>{{ aiHint }}</text>
      </view>

      <view class="ne-foot safe-bottom">
        <view class="ai-row">
          <view class="btn primary ne-ai" :class="{ busy: aiBusy }" @tap="aiPolish">
            <text>{{ aiBusy ? '完善中…' : 'AI 完善' }}</text>
          </view>
          <view class="btn ne-ai ne-req" :class="{ busy: aiBusy }" @tap="aiPolishWithRequirement">
            <text>按要求完善</text>
          </view>
          <view class="btn ne-ai ne-ctx" @tap="askAi"><text>问 AI</text></view>
        </view>
        <view class="sub-row">
          <view class="ne-sub" @tap="openMove"><text>移动到笔记本</text></view>
          <view class="ne-sub danger" @tap="confirmDelete"><text>删除</text></view>
          <text class="ne-hint">600ms 自动保存</text>
        </view>
      </view>
    </template>

    <MossSheet
      :visible="sheet.visible"
      :kind="sheet.kind"
      :title="sheet.title"
      :message="sheet.message"
      :items="sheet.items"
      :value="sheet.value"
      :placeholder="sheet.placeholder"
      :confirm-text="sheet.confirmText"
      @update:visible="sheet.visible = $event"
      @select="onSheetSelect"
      @confirm="onSheetConfirm"
    />
  </view>
</template>

<style lang="scss" scoped>
/* 根：整屏固定，中间正文内部滚动（键盘弹起时头尾不跟着走） */
.dsh.ne {
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-grad-1, var(--bg));
  color: var(--t1);
}

.ne-top {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px 6px;
}
.ne-back {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  border: 1px solid var(--bd);
  background: var(--s1);
  color: var(--t2);
  font-size: 22px;
  line-height: 1;
}
.ne-back:active { border-color: var(--bd-strong); }
.ne-save {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--t3);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
.ne-save.dirty { color: var(--warn); }
.sp { flex: 1; min-width: 0; }
.ne-star {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: var(--t3);
  font-size: 15px;
}
.ne-star.on { color: var(--warn); }

.seg {
  display: flex;
  flex: 0 0 auto;
  padding: 2px;
  border-radius: 10px;
  background: var(--s1);
  border: 1px solid var(--bd);
}
.seg-i {
  height: 28px;
  padding: 0 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--t3);
}
.seg-i.on {
  background: var(--acc-soft);
  color: var(--acc);
}

.ne-title {
  flex: 0 0 auto;
  width: 100%;
  height: 44px;
  padding: 0 16px 8px;
  border: 0;
  border-bottom: 1px solid var(--bd);
  background: transparent;
  color: var(--t1);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.2px;
  box-sizing: border-box;
}
.ne-meta {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 16px 2px;
}
.nb-tag {
  flex: 0 0 auto;
  font-size: 9.5px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 999px;
  color: var(--acc);
  background: var(--acc-soft);
  border: 1px solid var(--bd);
}
.ne-time,
.ne-wc { font-size: 10px; color: var(--t3); }
.ne-wc { margin-left: auto; }

.ne-scroll {
  flex: 1;
  height: 0;
  min-height: 0;
  width: 100%;
}
.ne-preview {
  padding: 12px 16px 20px;
  max-width: var(--content-max, 760px);
  margin: 0 auto;
  box-sizing: border-box;
}
.ne-empty {
  padding: 30px 0;
  font-size: 12px;
  color: var(--t3);
  text-align: center;
}

.ne-body {
  flex: 1;
  min-height: 160px;
  width: 100%;
  padding: 10px 16px 16px;
  border: 0;
  background: transparent;
  color: var(--t1);
  font-size: 14px;
  line-height: 1.9;
  box-sizing: border-box;
}

.ai-hint {
  flex: 0 0 auto;
  padding: 8px 16px;
  border-top: 1px solid var(--bd);
  background: var(--s1);
  font-size: 10px;
  line-height: 1.6;
  color: var(--t3);
}
.ai-hint.bad { color: var(--warn); }

.ne-foot {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 10px 14px;
  border-top: 1px solid var(--bd);
  background: var(--s2);
}
.ai-row { display: flex; align-items: center; gap: 8px; }
.ne-ai {
  flex: 1;
  width: auto;
  min-width: 0;
  min-height: 38px;
  height: 38px;
  padding: 0 10px;
  font-size: 12.5px;
  white-space: nowrap;
}
.ne-ai.busy {
  opacity: 0.6;
  pointer-events: none;
}
.ne-req {
  font-size: 11.5px;
  color: var(--t2);
}
/* 次按钮：浅色卡片 + 强调色文字，和 WorkShell 的浅色卡片观感一致 */
.ne-ctx {
  color: var(--acc);
  border-color: var(--bd-strong);
  background: var(--acc-soft);
}
.sub-row { display: flex; align-items: center; gap: 8px; }
.ne-sub {
  flex: 0 0 auto;
  height: 32px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  border-radius: 9px;
  border: 1px solid var(--bd);
  background: var(--s1);
  color: var(--t2);
  font-size: 11px;
}
.ne-sub.danger {
  color: var(--danger);
  border-color: var(--danger-bd);
  background: var(--danger-soft);
}
.ne-hint {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-size: 9.5px;
  color: var(--t3);
}

.ne-miss {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 0 26px;
  text-align: center;
}
.miss-title { font-size: 15px; font-weight: 700; color: var(--t1); }
.miss-sub { font-size: 11px; line-height: 1.7; color: var(--t3); }
.miss-btn {
  width: auto;
  margin-top: 8px;
  padding: 0 18px;
  min-height: 38px;
  height: 38px;
  font-size: 12.5px;
}

/* 窄屏（≤ 480）再压一档字号，保证 5 个动作不换行 */
@media (max-width: 380px) {
  .ne-ai { font-size: 11.5px; padding: 0 6px; }
  .seg-i { padding: 0 9px; }
}

/* 平板 / 桌面：读与写都限制阅读宽度，避免一行文字过长 */
@media (min-width: 820px) {
  .ne-top,
  .ne-title,
  .ne-meta,
  .ai-hint,
  .ne-foot { padding-left: 28px; padding-right: 28px; }
  .ne-title { height: 52px; font-size: 22px; }
  .ne-preview,
  .ne-body {
    max-width: 780px;
    margin: 0 auto;
    padding-left: 28px;
    padding-right: 28px;
  }
  .ne-foot { max-width: 100%; }
}
</style>
