<script setup lang="ts">
/**
 * 笔记屏：笔记本 chips 筛选 + 笔记卡列表 + 编辑器。
 *
 * 断点约定（与原型一致）：
 *   - < 820：列表与编辑器互斥，点开笔记后编辑器 fixed 全屏
 *   - ≥ 820：左列表 / 右编辑器两栏，进页面自动选中第一篇
 *
 * 自动保存：标题/正文任意输入 → 600ms 防抖后 updateNote；
 * 切笔记、关闭、离开页面都先 flush，保证"看到的就是存下的"。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import WorkShell from '@/components/WorkShell.vue'
import { addNote, isoDay, removeNote, updateNote, useWork } from '@/core/workbench'
import type { Note } from '@/core/workbench'
import { haptic } from '@/core/haptic'

const { data } = useWork()

const ALL = 'all'
const FAV = 'fav'

const filter = ref<string>(ALL)
const editingId = ref('')
const draftTitle = ref('')
const draftBody = ref('')
const saveState = ref<'saved' | 'dirty'>('saved')

const createOpen = ref(false)
const newNotebook = ref('')
const customNotebook = ref('')

let saveTimer: ReturnType<typeof setTimeout> | undefined

const notebooks = computed(() => {
  const map = new Map<string, number>()
  for (const n of data.value.notes) map.set(n.notebook, (map.get(n.notebook) ?? 0) + 1)
  return Array.from(map.entries()).map(([name, count]) => ({ name, count }))
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
const activeNote = computed<Note | null>(() => data.value.notes.find((n) => n.id === editingId.value) ?? null)
const wordCount = computed(() => draftBody.value.replace(/\s+/g, '').length)
const saveLabel = computed(() => (saveState.value === 'saved' ? '已保存 · 本地' : '待保存…'))
const pickerNotebooks = computed(() => {
  const names = notebooks.value.map((n) => n.name)
  return names.length > 0 ? names : ['默认']
})

function toast(title: string): void {
  uni.showToast({ title, icon: 'none', duration: 1800 })
}

function summary(n: Note): string {
  const plain = n.content
    .replace(/[#>*`_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain
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

function flush(): void {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  const id = editingId.value
  if (id === '') return
  const note = data.value.notes.find((n) => n.id === id)
  if (note === undefined) {
    saveState.value = 'saved'
    return
  }
  if (note.title === draftTitle.value && note.content === draftBody.value) {
    saveState.value = 'saved'
    return
  }
  updateNote(id, { title: draftTitle.value, content: draftBody.value })
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

function loadDraft(note: Note): void {
  editingId.value = note.id
  draftTitle.value = note.title
  draftBody.value = note.content
  saveState.value = 'saved'
}

function openNote(id: string): void {
  if (id === editingId.value) return
  flush()
  const note = data.value.notes.find((n) => n.id === id)
  if (note === undefined) return
  haptic('light')
  loadDraft(note)
}

function closeEditor(): void {
  flush()
  editingId.value = ''
  draftTitle.value = ''
  draftBody.value = ''
}

function discardEditor(): void {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  editingId.value = ''
  draftTitle.value = ''
  draftBody.value = ''
  saveState.value = 'saved'
}

function setFilter(key: string): void {
  if (filter.value === key) return
  haptic('light')
  flush()
  filter.value = key
}

function toggleFav(id: string): void {
  haptic('light')
  const note = data.value.notes.find((n) => n.id === id)
  if (note === undefined) return
  updateNote(id, { fav: !note.fav })
  toast(note.fav ? '已取消收藏' : '已收藏')
}

function confirmDelete(): void {
  const note = activeNote.value
  if (note === null) return
  const title = note.title || '未命名笔记'
  uni.showModal({
    title: '删除这篇笔记？',
    content: `「${title}」删除后不可恢复（M1 没有回收站）。`,
    confirmText: '删除',
    cancelText: '取消',
    success: (res) => {
      if (!res.confirm) return
      removeNote(note.id)
      discardEditor()
      haptic('medium')
      toast('已删除')
    },
  })
}

function openCreate(): void {
  haptic('light')
  if (!pickerNotebooks.value.includes(newNotebook.value)) {
    newNotebook.value = pickerNotebooks.value[0] ?? '默认'
  }
  customNotebook.value = ''
  createOpen.value = true
}

function createNote(): void {
  let notebook = newNotebook.value
  if (notebook === '__new__') {
    notebook = customNotebook.value.trim()
    if (notebook === '') {
      toast('请先填一个笔记本名称')
      return
    }
  }
  if (notebook === '') notebook = '默认'
  flush()
  const note = addNote(notebook)
  createOpen.value = false
  customNotebook.value = ''
  filter.value = notebook
  loadDraft(note)
  haptic('medium')
  toast(`已在「${notebook}」新建笔记`)
}

function aiPolish(): void {
  haptic('light')
  toast('AI 完善将在 M2 接入：只改标题/正文，笔记本与标签不动')
}

function selectFirstForWide(): void {
  try {
    const info = uni.getSystemInfoSync()
    if (info.windowWidth < 820) return
    if (filteredNotes.value.length === 0) return
    const first = filteredNotes.value[0]
    if (first !== undefined) loadDraft(first)
  } catch {
    /* 取不到窗口宽度就按手机处理 */
  }
}

// 切设备域后当前编辑的笔记可能已不存在；同时把失效的笔记本筛选拉回「全部」
watch(data, () => {
  if (editingId.value !== '' && activeNote.value === null) discardEditor()
  const valid = filter.value === ALL || filter.value === FAV || data.value.notes.some((n) => n.notebook === filter.value)
  if (!valid) filter.value = ALL
})

onMounted(selectFirstForWide)

onUnmounted(() => {
  flush()
  if (saveTimer !== undefined) clearTimeout(saveTimer)
})
</script>

<template>
  <WorkShell active="notes" title="笔记" :sub="`${data.notes.length} 篇 · 本地存储 · 笔记本 / 标签不丢`">
    <view class="notes-page" :class="{ 'is-editing': editingId !== '' }">
      <view class="page-head">
        <text class="head-note">自动保存 · 离线可用 · M2 与 DSH 双向同步</text>
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
          <view
            v-for="nb in notebooks"
            :key="nb.name"
            class="chip"
            :class="{ on: filter === nb.name }"
            @tap="setFilter(nb.name)"
          >
            <text>{{ nb.name }}</text>
            <text class="chip-n mono">{{ nb.count }}</text>
          </view>
        </view>
      </scroll-view>

      <view class="workspace">
        <view class="list-col">
          <view v-if="filteredNotes.length === 0" class="empty">
            <text>这里还没有笔记。</text>
            <text class="empty-hint">右上角「新建」，或换一个笔记本看看。</text>
          </view>

          <view
            v-for="n in filteredNotes"
            :key="n.id"
            class="note-card"
            :class="{ on: n.id === editingId }"
            @tap="openNote(n.id)"
          >
            <view class="nc-top">
              <text class="nc-title">{{ n.title || '未命名笔记' }}</text>
              <view class="star" :class="{ on: n.fav }" @tap.stop="toggleFav(n.id)">
                <text>{{ n.fav ? '★' : '☆' }}</text>
              </view>
            </view>
            <view class="nc-sum"><text>{{ summary(n) || '空白笔记 · 点开写点什么' }}</text></view>
            <view class="nc-meta">
              <text class="nb-tag">{{ n.notebook }}</text>
              <text v-for="tag in n.tags" :key="tag" class="tag">#{{ tag }}</text>
              <text class="nc-time mono">{{ timeLabel(n.updatedAt) }}</text>
            </view>
          </view>
        </view>

        <view v-if="activeNote" class="edit-col">
          <view class="editor">
            <view class="ed-toolbar">
              <view class="ed-back" @tap="closeEditor"><text>‹</text></view>
              <text class="ed-save" :class="saveState">{{ saveLabel }}</text>
              <view class="sp" />
              <view class="ed-star" :class="{ on: activeNote.fav }" @tap="toggleFav(activeNote.id)">
                <text>{{ activeNote.fav ? '★' : '☆' }}</text>
              </view>
              <view class="ed-del" @tap="confirmDelete"><text>删除</text></view>
            </view>

            <view class="ed-main">
              <input
                v-model="draftTitle"
                class="ed-title"
                placeholder="标题…"
                placeholder-style="color: var(--t3)"
                :maxlength="-1"
                @input="scheduleSave"
              />
              <view class="ed-metarow">
                <text class="nb-tag">{{ activeNote.notebook }}</text>
                <text class="ed-time mono">{{ timeLabel(activeNote.updatedAt) }}</text>
                <text class="ed-wc mono">{{ wordCount }} 字</text>
              </view>
              <textarea
                v-model="draftBody"
                class="ed-body"
                placeholder="开始写… 支持 Markdown 习惯的纯文本"
                placeholder-style="color: var(--t3)"
                :maxlength="-1"
                :show-confirm-bar="false"
                @input="scheduleSave"
                @blur="flush"
              ></textarea>
            </view>

            <view class="ed-foot">
              <view class="btn primary ed-ai" @tap="aiPolish">AI 完善</view>
              <text class="foot-hint">输入后 600ms 自动保存 · 不丢笔记本/标签</text>
            </view>
          </view>
        </view>

        <view v-else class="edit-placeholder">
          <text class="ph-mark">▤</text>
          <text class="ph-title">选择一篇笔记开始编辑</text>
          <text class="ph-sub">左侧列表会实时筛选；新建时可选已有或新的笔记本。</text>
        </view>
      </view>
    </view>

    <!-- 新建：选择 / 新建笔记本 -->
    <view v-if="createOpen" class="mask" @tap="createOpen = false">
      <view class="create-sheet" @tap.stop>
        <text class="cs-title">新建笔记</text>
        <text class="cs-cap">选择笔记本</text>
        <view class="cs-nbs">
          <view
            v-for="nb in pickerNotebooks"
            :key="nb"
            class="cs-nb"
            :class="{ on: newNotebook === nb }"
            @tap="newNotebook = nb"
          >
            <text>{{ nb }}</text>
          </view>
          <view class="cs-nb new" :class="{ on: newNotebook === '__new__' }" @tap="newNotebook = '__new__'">
            <text>＋ 新笔记本</text>
          </view>
        </view>
        <input
          v-if="newNotebook === '__new__'"
          v-model="customNotebook"
          class="cs-input"
          placeholder="新笔记本名称"
          placeholder-style="color: var(--t3)"
          :maxlength="-1"
        />
        <view class="cs-actions">
          <view class="btn" @tap="createOpen = false">取消</view>
          <view class="btn primary" @tap="createNote">创建并编辑</view>
        </view>
      </view>
    </view>
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

.workspace { display: flex; flex-direction: column; min-width: 0; }
.list-col { flex: 1; min-width: 0; }

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
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.5;
  color: var(--t1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
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
  -webkit-line-clamp: 2;
  overflow: hidden;
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.75;
  color: var(--t3);
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

/* ── 编辑器 ── */
.edit-col { display: none; }
.editor {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--s1);
  border: 1px solid var(--bd);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.ed-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--bd);
  background: color-mix(in srgb, var(--s2) 60%, transparent);
}
.ed-back {
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
.ed-save {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--t3);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
.ed-save.dirty { color: var(--warn); }
.sp { flex: 1; }
.ed-star {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: var(--t3);
  font-size: 14px;
}
.ed-star.on { color: var(--warn); }
.ed-del {
  height: 30px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  border-radius: 9px;
  border: 1px solid var(--danger-bd);
  color: var(--danger);
  font-size: 10.5px;
  background: var(--danger-soft);
}
.ed-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 16px 0;
}
.ed-title {
  width: 100%;
  height: 40px;
  padding: 0 0 8px;
  border: 0;
  border-bottom: 1px solid var(--bd);
  background: transparent;
  color: var(--t1);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.2px;
}
.ed-metarow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 9px 0 6px;
}
.ed-time,
.ed-wc { font-size: 10px; color: var(--t3); }
.ed-wc { margin-left: auto; }
.ed-body {
  flex: 1;
  width: 100%;
  min-height: 220px;
  padding: 10px 0 16px;
  border: 0;
  background: transparent;
  color: var(--t1);
  font-size: 13.5px;
  line-height: 1.95;
}
.ed-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--bd);
  background: var(--s2);
}
.ed-ai {
  flex: 0 0 auto;
  width: auto;
  min-height: 38px;
  height: 38px;
  padding: 0 16px;
  font-size: 12.5px;
}
.foot-hint {
  flex: 1;
  min-width: 0;
  font-size: 9.5px;
  line-height: 1.5;
  color: var(--t3);
  text-align: right;
}

.edit-placeholder {
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

/* 选笔记本浮层 */
.mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: color-mix(in srgb, var(--bg) 76%, transparent);
}
.create-sheet {
  width: 100%;
  max-width: 440px;
  padding: 18px;
  border-radius: var(--r-lg);
  background: var(--s1);
  border: 1px solid var(--bd);
}
.cs-title {
  display: block;
  font-size: 16px;
  font-weight: 700;
  color: var(--t1);
}
.cs-cap {
  display: block;
  margin-top: 14px;
  margin-bottom: 8px;
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--t3);
}
.cs-nbs { display: flex; flex-wrap: wrap; gap: 8px; }
.cs-nb {
  height: 34px;
  padding: 0 13px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t2);
  font-size: 12px;
}
.cs-nb.on {
  border-color: var(--bd-strong);
  background: var(--acc-soft);
  color: var(--acc);
}
.cs-nb.new { border-style: dashed; }
.cs-input {
  width: 100%;
  height: 42px;
  margin-top: 10px;
  padding: 0 12px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--s2);
  color: var(--t1);
  font-size: 13px;
}
.cs-actions { display: flex; gap: 10px; margin-top: 18px; }

/* ── 手机：编辑器全屏 ── */
@media (max-width: 819px) {
  .notes-page.is-editing .page-head,
  .notes-page.is-editing .chips,
  .notes-page.is-editing .list-col { display: none; }
  .notes-page.is-editing .edit-col {
    display: flex;
    position: fixed;
    inset: 0;
    z-index: 70;
    flex-direction: column;
    background: var(--bg);
    padding-top: var(--safe-top-real, 24px);
  }
  .notes-page.is-editing .edit-col .editor {
    border: 0;
    border-radius: 0;
    height: 100%;
  }
  .notes-page.is-editing .ed-main { padding-bottom: 8px; }
  .notes-page.is-editing .ed-body { min-height: 160px; }
}

/* ── 平板 / 桌面：左右两栏 ── */
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
  .edit-col {
    display: flex;
    flex: 1;
    min-width: 0;
  }
  .editor {
    /* 减去顶栏 + 设备 chips + 页头 + 底栏：让 AI 完善那一行停在 Tab 上方 */
    height: calc(100vh - 302px);
    min-height: 380px;
    max-height: 760px;
  }
  .ed-back { display: none; }
  .edit-placeholder { display: flex; }
  .head-new { height: 34px; min-height: 34px; }
}
</style>
