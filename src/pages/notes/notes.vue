<script setup lang="ts">
/**
 * 笔记屏：笔记本 chips + 笔记卡列表 + 阅读态。
 *
 * 两段式：
 *   列表（轻） → 阅读态（渲染后的 Markdown） → 「编辑」进整页编辑器
 *   `/pages/note-edit/note-edit?id=xxx`（见 pages/note-edit/note-edit.vue）
 *
 * 断点约定（与原型一致）：
 *   - < 820：列表与阅读态互斥，点开笔记后阅读态 fixed 全屏
 *   - ≥ 820：左列表 / 右阅读两栏，进页面自动读第一篇
 *
 * 为什么列表页不再内嵌编辑器：
 *   手机上一屏同时放列表与 textarea，键盘弹起后正文只剩三行；
 *   而且"点开即进入编辑"让人没法先读完再决定改不改。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import WorkShell from '@/components/WorkShell.vue'
import MossMarkdown from '@/components/MossMarkdown.vue'
import MossSheet, { type SheetItem } from '@/components/MossSheet.vue'
import {
  addNote,
  addNotebook,
  isoDay,
  removeNotebook,
  renameNotebook,
  updateNote,
  useWork,
} from '@/core/workbench'
import type { Note } from '@/core/workbench'
import { haptic } from '@/core/haptic'

const { data } = useWork()

const ALL = 'all'
const FAV = 'fav'

const filter = ref<string>(ALL)
/** 阅读态：正在读哪篇（空 = 没选中）；编辑走独立路由 */
const readingId = ref('')

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

/* ─────────── 派生数据 ─────────── */

/**
 * 笔记本行 = 清单 ∪ 笔记里出现的名字。
 *
 * 为什么要并集：同步来的笔记可能指向本地清单里没有的笔记本（旧版本/其它端），
 * 只按清单展示会让这些笔记在筛选里"消失"。
 */
const notebookRows = computed<{ name: string; count: number }[]>(() => {
  const counts = new Map<string, number>()
  for (const n of data.value.notes) counts.set(n.notebook, (counts.get(n.notebook) ?? 0) + 1)
  const names = data.value.notebooks.map((n) => n.name)
  for (const name of counts.keys()) {
    if (!names.includes(name)) names.push(name)
  }
  return names.map((name) => ({ name, count: counts.get(name) ?? 0 }))
})
const favCount = computed(() => data.value.notes.filter((n) => n.fav).length)
const filteredNotes = computed<Note[]>(() => {
  const f = filter.value
  const list = data.value.notes.filter((n) => {
    if (f === ALL) return true
    if (f === FAV) return n.fav
    return n.notebook === f
  })
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
})
const readingNote = computed<Note | null>(
  () => data.value.notes.find((n) => n.id === readingId.value) ?? null,
)
const readingWordCount = computed(() =>
  (readingNote.value?.content ?? '').replace(/\s+/g, '').length,
)

/* ─────────── 工具 ─────────── */

function toast(title: string): void {
  uni.showToast({ title, icon: 'none', duration: 1800 })
}

function summary(n: Note): string {
  const plain = n.content
    .replace(/[#>*`_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 120 ? `${plain.slice(0, 120)}…` : plain
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

/* ─────────── 阅读态 / 编辑入口 ─────────── */

function openNote(id: string): void {
  if (readingId.value === id) return
  haptic('light')
  readingId.value = id
}

function closeReader(): void {
  haptic('light')
  readingId.value = ''
}

/** 编辑：走整页路由（数据层共享同一份 store，返回后阅读态自动是新内容） */
function openEditor(id: string): void {
  if (id === '') return
  haptic('light')
  uni.navigateTo({ url: `/pages/note-edit/note-edit?id=${id}` })
}

function setFilter(key: string): void {
  if (filter.value === key) return
  haptic('light')
  filter.value = key
}

function toggleFav(id: string): void {
  haptic('light')
  const note = data.value.notes.find((n) => n.id === id)
  if (note === undefined) return
  updateNote(id, { fav: !note.fav })
  toast(note.fav ? '已取消收藏' : '已收藏')
}

/* ─────────── 新建（选已有笔记本 / 新建笔记本） ─────────── */

function createIn(notebook: string): void {
  const note = addNote(notebook)
  filter.value = notebook
  haptic('medium')
  // 新笔记是空的：直接进整页编辑器，不在列表里多一步
  uni.navigateTo({ url: `/pages/note-edit/note-edit?id=${note.id}` })
}

function promptNewNotebook(mode: 'create-note' | 'only'): void {
  openSheet({
    kind: 'prompt',
    title: '新建笔记本',
    message: mode === 'create-note' ? '给笔记本取个名字，新笔记会建在里面。' : '给笔记本取个名字。',
    placeholder: '例如：项目 A',
    confirmText: '创建',
    onConfirm: (text) => {
      const nb = addNotebook(text)
      if (nb === undefined) {
        toast('请先填写笔记本名称')
        return
      }
      haptic('medium')
      filter.value = nb.name
      if (mode === 'create-note') createIn(nb.name)
      else toast(`已新建「${nb.name}」`)
    },
  })
}

function openCreate(): void {
  haptic('light')
  const names = notebookRows.value.map((n) => n.name)
  const items: SheetItem[] = names.map((name) => ({ label: name, hint: `新建到「${name}」` }))
  items.push({ label: '＋ 新建笔记本', hint: '创建笔记本并写第一篇' })
  openSheet({
    kind: 'menu',
    title: '新建笔记',
    items,
    onSelect: (index) => {
      if (index < names.length) {
        createIn(names[index] as string)
        return
      }
      promptNewNotebook('create-note')
    },
  })
}

/* ─────────── 笔记本菜单（长按 chip 或点 ⋯） ─────────── */

function openNotebookMenu(name: string): void {
  haptic('light')
  openSheet({
    kind: 'menu',
    title: `笔记本「${name}」`,
    items: [
      { label: '改名', hint: '本内笔记一起换到新名字下' },
      { label: '删除', hint: '笔记会移到「未分类」，内容不会丢', danger: true },
    ],
    onSelect: (index) => {
      if (index === 0) promptRenameNotebook(name)
      else confirmRemoveNotebook(name)
    },
  })
}

function promptRenameNotebook(from: string): void {
  openSheet({
    kind: 'prompt',
    title: '笔记本改名',
    message: `「${from}」的新名字：`,
    value: from,
    placeholder: '笔记本名称',
    confirmText: '保存',
    onConfirm: (text) => {
      const to = text.trim()
      if (to === '' || to === from) {
        toast('名称没有变化')
        return
      }
      if (data.value.notebooks.some((n) => n.name === to)) {
        toast('已有同名笔记本')
        return
      }
      renameNotebook(from, to)
      if (filter.value === from) filter.value = to
      haptic('medium')
      toast('已改名')
    },
  })
}

function confirmRemoveNotebook(name: string): void {
  const count = data.value.notes.filter((n) => n.notebook === name).length
  openSheet({
    kind: 'confirm',
    title: `删除笔记本「${name}」？`,
    message: count > 0
      ? `本内 ${count} 篇笔记会移到「未分类」，内容不会丢。`
      : '这个笔记本里还没有笔记。',
    confirmText: '删除',
    onConfirm: () => {
      removeNotebook(name)
      if (filter.value === name) filter.value = ALL
      haptic('medium')
      toast('已删除笔记本')
    },
  })
}

/* ─────────── 生命周期 ─────────── */

function selectFirstForWide(): void {
  try {
    const info = uni.getSystemInfoSync()
    if (info.windowWidth < 820) return
    if (filteredNotes.value.length === 0) return
    const first = filteredNotes.value[0]
    if (first !== undefined && readingId.value === '') readingId.value = first.id
  } catch {
    /* 取不到窗口宽度就按手机处理 */
  }
}

// 切设备域/同步后当前阅读的笔记可能已不存在；把失效的筛选拉回「全部」
watch(data, () => {
  if (readingId.value !== '' && readingNote.value === null) readingId.value = ''
  const valid = filter.value === ALL
    || filter.value === FAV
    || data.value.notebooks.some((n) => n.name === filter.value)
    || data.value.notes.some((n) => n.notebook === filter.value)
  if (!valid) filter.value = ALL
})

onMounted(selectFirstForWide)
</script>

<template>
  <WorkShell active="notes" title="笔记" :sub="`${data.notes.length} 篇 · 本地存储 · 笔记本 / 标签不丢`">
    <view class="notes-page" :class="{ 'is-reading': readingId !== '' }">
      <view class="page-head">
        <text class="head-note">点笔记先读 · 右上「编辑」再写 · 自动保存 · 离线可用</text>
        <view class="btn primary head-new" @tap="openCreate">＋ 新建</view>
      </view>

      <scroll-view scroll-x class="chips" :show-scrollbar="false">
        <view class="chip-row">
          <view class="chip" :class="{ on: filter === ALL }" @tap="setFilter(ALL)">
            <text>全部</text>
            <text class="chip-n mono">{{ data.notes.length }}</text>
          </view>
          <view class="chip" :class="{ on: filter === FAV }" @tap="setFilter(FAV)">
            <text>收藏</text>
            <text class="chip-n mono">{{ favCount }}</text>
          </view>
          <!-- 笔记本 chip：长按（或点 ⋯）出菜单；点本体只做筛选 -->
          <view
            v-for="nb in notebookRows"
            :key="nb.name"
            class="chip nb"
            :class="{ on: filter === nb.name }"
            @tap="setFilter(nb.name)"
            @longpress="openNotebookMenu(nb.name)"
          >
            <text>{{ nb.name }}</text>
            <text class="chip-n mono">{{ nb.count }}</text>
            <view class="chip-more" @tap.stop="openNotebookMenu(nb.name)">
              <text>⋯</text>
            </view>
          </view>
          <view class="chip add" @tap="promptNewNotebook('only')">
            <text>＋ 新建笔记本</text>
          </view>
        </view>
      </scroll-view>

      <view class="workspace">
        <!-- 宽屏（PC 档）笔记本列表：手机走上面的 chips，两处共用同一套筛选状态 -->
        <view class="nb-col">
          <view class="nb-head">
            <text class="nb-head-t">笔记本</text>
            <text class="nb-head-n mono">{{ data.notes.length }}</text>
          </view>
          <view class="nb-row" :class="{ on: filter === ALL }" @tap="setFilter(ALL)">
            <text class="nb-name">全部</text>
            <text class="nb-count mono">{{ data.notes.length }}</text>
          </view>
          <view class="nb-row" :class="{ on: filter === FAV }" @tap="setFilter(FAV)">
            <text class="nb-name">收藏</text>
            <text class="nb-count mono">{{ favCount }}</text>
          </view>
          <view
            v-for="nb in notebookRows"
            :key="nb.name"
            class="nb-row"
            :class="{ on: filter === nb.name }"
            @tap="setFilter(nb.name)"
            @longpress="openNotebookMenu(nb.name)"
          >
            <text class="nb-name">{{ nb.name }}</text>
            <text class="nb-count mono">{{ nb.count }}</text>
            <view class="nb-more" @tap.stop="openNotebookMenu(nb.name)"><text>⋯</text></view>
          </view>
          <view class="nb-add" @tap="promptNewNotebook('only')">
            <text>＋ 新建笔记本</text>
          </view>
        </view>

        <view class="list-col">
          <view v-if="filteredNotes.length === 0" class="empty">
            <text>这里还没有笔记。</text>
            <text class="empty-hint">右上角「新建」，或换一个笔记本看看。</text>
          </view>

          <view
            v-for="n in filteredNotes"
            :key="n.id"
            class="note-card"
            :class="{ on: n.id === readingId }"
            @tap="openNote(n.id)"
          >
            <view class="nc-top">
              <text class="nc-title">{{ n.title || '未命名笔记' }}</text>
              <view class="star" :class="{ on: n.fav }" @tap.stop="toggleFav(n.id)">
                <text>{{ n.fav ? '★' : '☆' }}</text>
              </view>
            </view>
            <view class="nc-sum"><text>{{ summary(n) || '空白笔记 · 点开读或写' }}</text></view>
            <view class="nc-meta">
              <text class="nb-tag">{{ n.notebook }}</text>
              <text v-for="tag in n.tags" :key="tag" class="tag">#{{ tag }}</text>
              <text class="nc-time mono">{{ timeLabel(n.updatedAt) }}</text>
            </view>
          </view>
        </view>

        <!-- 阅读态：标题 + 渲染后的 Markdown；右上「编辑」进整页编辑器 -->
        <view v-if="readingNote" class="read-col">
          <view class="reader">
            <view class="rd-toolbar">
              <view class="rd-back" @tap="closeReader"><text>‹</text></view>
              <text class="nb-tag">{{ readingNote.notebook }}</text>
              <text class="rd-time mono">{{ timeLabel(readingNote.updatedAt) }}</text>
              <view class="sp" />
              <view class="rd-star" :class="{ on: readingNote.fav }" @tap="toggleFav(readingNote.id)">
                <text>{{ readingNote.fav ? '★' : '☆' }}</text>
              </view>
              <view class="rd-edit" @tap="openEditor(readingNote.id)"><text>编辑</text></view>
            </view>

            <scroll-view scroll-y class="rd-body">
              <view class="rd-inner">
                <text class="rd-title">{{ readingNote.title || '未命名笔记' }}</text>
                <view class="rd-meta">
                  <text v-for="tag in readingNote.tags" :key="tag" class="tag">#{{ tag }}</text>
                  <text class="rd-wc mono">{{ readingWordCount }} 字</text>
                </view>
                <MossMarkdown
                  v-if="readingNote.content.trim().length > 0"
                  class="rd-md"
                  :text="readingNote.content"
                />
                <view v-else class="rd-empty">
                  <text>空白笔记 · 点右上「编辑」写点什么</text>
                </view>
              </view>
            </scroll-view>
          </view>
        </view>

        <view v-else class="read-placeholder">
          <text class="ph-mark">▤</text>
          <text class="ph-title">点开一篇笔记先读</text>
          <text class="ph-sub">阅读态渲染 Markdown；右上「编辑」进入整页编辑。</text>
        </view>
      </view>
    </view>

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
  </WorkShell>
</template>

<style lang="scss" scoped>
.notes-page { padding-top: 2px; }

.page-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 2px 10px;
}
.head-note {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--t3);
  line-height: 1.6;
}
.head-new {
  flex: 0 0 auto;
  width: auto;
  min-height: 36px;
  height: 36px;
  padding: 0 14px;
  font-size: 12.5px;
}

.chips { white-space: nowrap; padding-bottom: 2px; }
.chip-row { display: flex; gap: 8px; padding: 2px 1px 10px; }
.chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--s1);
  border: 1px solid var(--bd);
  color: var(--t2);
  font-size: 11.5px;
  font-weight: 600;
  transition: background 160ms var(--ease-out), border-color 160ms var(--ease-out);
}
.chip:active { transform: scale(0.97); }
.chip.on {
  background: var(--acc-soft);
  border-color: var(--bd-strong);
  color: var(--acc);
}
.chip-n { font-size: 9.5px; color: var(--t3); }
.chip.on .chip-n { color: var(--acc); }
.chip.nb { padding-right: 6px; }
/* ⋯ 是笔记本菜单的显式入口：长按不直观，右键 H5 才有 */
.chip-more {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  color: var(--t3);
  font-size: 13px;
  line-height: 1;
}
.chip-more:active { background: var(--s3); color: var(--t1); }
.chip.add {
  color: var(--t3);
  border-style: dashed;
  font-weight: 500;
}
.chip.add:active { color: var(--acc); border-color: var(--bd-strong); }

.workspace { display: flex; flex-direction: column; min-width: 0; }
.list-col { flex: 1; min-width: 0; }

/* 笔记本竖列表：只有 PC 档显示；手机由顶部 chips 承担同一职责 */
.nb-col { display: none; }
.nb-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px 8px;
}
.nb-head-t { font-size: 11.5px; font-weight: 700; color: var(--t2); letter-spacing: 0.04em; }
.nb-head-n { margin-left: auto; font-size: 9.5px; color: var(--t3); }
.nb-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 8px;
  border-radius: 9px;
  color: var(--t2);
  font-size: 12px;
}
.nb-row:active { background: var(--s2); }
.nb-row.on { background: var(--acc-soft); color: var(--acc); font-weight: 600; }
.nb-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.nb-count { margin-left: auto; font-size: 9.5px; color: var(--t3); }
.nb-row.on .nb-count { color: var(--acc); }
.nb-more {
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  color: var(--t3);
  font-size: 13px;
  line-height: 1;
}
.nb-more:active { background: var(--s3); color: var(--t1); }
.nb-add {
  margin-top: 6px;
  min-height: 34px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  border-radius: 9px;
  border: 1px dashed var(--bd);
  color: var(--t3);
  font-size: 11.5px;
}
.nb-add:active { color: var(--acc); border-color: var(--bd-strong); }

/* ── 卡片：高度完全由内容撑开（不写 height，标题 2 行 / 摘要 3 行截断） ── */
.note-card {
  position: relative;
  padding: 14px;
  margin-bottom: 10px;
  border-radius: var(--r-md);
  background: var(--s1);
  border: 1px solid var(--bd);
  transition: border-color 160ms var(--ease-out), background 160ms var(--ease-out);
}
.note-card:active { transform: scale(0.995); }
.note-card.on {
  border-color: var(--bd-strong);
  background: var(--acc-soft);
}
.nc-top { display: flex; align-items: flex-start; gap: 8px; }
.nc-title {
  flex: 1;
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.45;
  color: var(--t1);
}
.star {
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: var(--t3);
  font-size: 14px;
}
.star.on { color: var(--warn); }
.nc-sum {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--t3);
  word-break: break-word;
}
.nc-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 9px;
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
.tag {
  font-size: 9.5px;
  color: var(--t3);
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--s2);
}
.nc-time {
  margin-left: auto;
  font-size: 10px;
  color: var(--t3);
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 26px 16px;
  border-radius: var(--r-md);
  border: 1px dashed var(--bd);
  font-size: 12px;
  color: var(--t2);
}
.empty-hint { font-size: 10.5px; color: var(--t3); line-height: 1.7; }

/* ── 阅读态 ── */
.read-col { display: none; }
.reader {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--s1);
  border: 1px solid var(--bd);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.rd-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--bd);
  background: color-mix(in srgb, var(--s2) 60%, transparent);
}
.rd-back {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t2);
  font-size: 18px;
  line-height: 1;
}
.rd-time { font-size: 10px; color: var(--t3); }
.sp { flex: 1; min-width: 0; }
.rd-star {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: var(--t3);
  font-size: 14px;
}
.rd-star.on { color: var(--warn); }
.rd-edit {
  height: 30px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  border-radius: 9px;
  border: 1px solid var(--bd-strong);
  background: var(--acc-soft);
  color: var(--acc);
  font-size: 11.5px;
  font-weight: 600;
}
.rd-edit:active { opacity: 0.75; }

.rd-body {
  flex: 1;
  height: 0;
  min-height: 0;
}
.rd-inner {
  padding: 16px 16px 26px;
  max-width: 780px;
  margin: 0 auto;
  box-sizing: border-box;
}
.rd-title {
  display: block;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: -0.2px;
  color: var(--t1);
  word-break: break-word;
}
.rd-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 9px 0 14px;
}
.rd-wc {
  margin-left: auto;
  font-size: 10px;
  color: var(--t3);
}
.rd-md { display: block; }
.rd-empty {
  padding: 26px 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--t3);
  text-align: center;
}

.read-placeholder {
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  min-height: 380px;
  border: 1px dashed var(--bd);
  border-radius: var(--r-lg);
  color: var(--t3);
}
.ph-mark { font-size: 30px; color: var(--acc); opacity: 0.7; }
.ph-title { font-size: 13px; font-weight: 600; color: var(--t2); }
.ph-sub { font-size: 10.5px; line-height: 1.7; text-align: center; padding: 0 24px; }

/* ── 手机：阅读态全屏 ── */
@media (max-width: 819px) {
  .notes-page.is-reading .page-head,
  .notes-page.is-reading .chips,
  .notes-page.is-reading .list-col { display: none; }
  .notes-page.is-reading .read-col {
    display: flex;
    position: fixed;
    inset: 0;
    z-index: 70;
    flex-direction: column;
    background: var(--bg);
    padding-top: var(--safe-top-real, 24px);
  }
  .notes-page.is-reading .read-col .reader {
    border: 0;
    border-radius: 0;
    height: 100%;
  }
  .notes-page.is-reading .rd-inner { padding-bottom: calc(24px + var(--safe-bottom-real)); }
}

/* ── 平板 / 桌面：左列表 + 右阅读 ── */
@media (min-width: 820px) {
  .workspace {
    flex-direction: row;
    align-items: flex-start;
    gap: 16px;
  }
  .list-col {
    flex: 0 0 336px;
    width: 336px;
  }
  .read-col {
    display: flex;
    flex: 1;
    min-width: 0;
  }
  .reader {
    /* 减去顶栏 + 设备 chips + 页头 + 底栏：让阅读区停在 Tab 上方 */
    height: calc(100vh - 302px);
    min-height: 380px;
    max-height: 760px;
  }
  .rd-back { display: none; }
  .read-placeholder { display: flex; }
  .head-new { height: 34px; min-height: 34px; }
}

/* ── PC 档（≥1100）：笔记本列表竖排在左，顶部 chips 收起 ── */
@media (min-width: 1100px) {
  .nb-col {
    display: flex;
    flex-direction: column;
    flex: 0 0 176px;
    width: 176px;
    padding: 10px 8px 12px;
    border-radius: var(--r-md);
    background: var(--s1);
    border: 1px solid var(--bd);
    box-sizing: border-box;
  }
  .chips { display: none; }
  .list-col {
    flex: 0 0 320px;
    width: 320px;
  }
  /* 少了 chips 一条，阅读卡可以再高一点，但仍要给底栏留空间 */
  .reader { height: calc(100vh - 286px); }
}
</style>
