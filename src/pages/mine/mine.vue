<script setup lang="ts">
/**
 * 我的：设备域卡 + 同步状态 + 设置 + 关于 + 旧页入口。
 *
 * 这里的设置直接读写 core/store 的 state：
 * 皮肤与明暗是全局的，改完 WorkShell 的根 class 立刻变，
 * 同时用 markUserPreference 落盘，冷启动不会被系统主题改回去。
 */
import { pendingCount, lastSyncAt, stateOf, syncStatus } from '@/core/sync-queue'
import { syncNow } from '@/core/sync-engine'
import { computed, ref } from 'vue'
import WorkShell from '@/components/WorkShell.vue'
import { deviceName, domainStats, switchDevice, useWork, work, workDevices } from '@/core/workbench'
import { markUserPreference, state } from '@/core/store'
import { haptic } from '@/core/haptic'

const APP_VERSION = '0.1.0'
const PROTOCOL_LABEL = 'DSH Link · v1'

const { data } = useWork()

const currentDevice = computed(() => workDevices.value.find((d) => d.id === work.deviceId) ?? workDevices.value[0])
/** state 里可能是 auto：按当前实际生效的皮肤高亮，避免两个选项都不亮 */
const activeSkin = computed<'moss' | '550w'>(() => (state.skinMode === '550w' ? '550w' : 'moss'))
const stats = computed(() => domainStats(data.value))
const pending = computed(() => pendingCount(work.deviceId))
const lastSyncText = computed(() => {
  const at = lastSyncAt(work.deviceId)
  if (at === 0) return '尚未同步'
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000))
  return mins < 1 ? '刚刚' : `${mins} 分钟前`
})
const conflicts = computed(() => data.value.tasks.filter((t) => t.conflict).length)

/* ── 同步面板（P1-4）：真实队列 + 手动同步 ── */
const panelOpen = ref(false)
const syncing = computed(() => syncStatus.syncing)

const entityRows = computed(() => {
  const s = stateOf(work.deviceId)
  const by: Record<string, number> = {}
  for (const d of s.dirty) by[d.entity] = (by[d.entity] ?? 0) + 1
  const label: Record<string, string> = {
    tasks: '任务', notes: '笔记', notebooks: '笔记本', news_topics: '资讯订阅', focus_sessions: '专注', spaces: '空间',
  }
  return Object.entries(by).map(([k, n]) => ({ name: label[k] ?? k, n }))
})

const conflictNotes = computed(() => data.value.notes.filter((n) => n.title.startsWith('冲突副本')))

function goDevices(): void {
  uni.reLaunch({ url: '/pages/index/index' })
}

function openNotes(): void {
  panelOpen.value = false
  uni.reLaunch({ url: '/pages/notes/notes' })
}

async function doSync(): Promise<void> {
  if (syncing.value) return
  const r = await syncNow()
  haptic('light')
  if (r.ok) {
    uni.showToast({ title: `同步完成 · 推送 ${r.pushed} · 拉取 ${r.applied}`, icon: 'none' })
  } else {
    uni.showToast({ title: r.reason === 'offline' ? '未连接设备 · 仅本机可用' : '同步失败，稍后重试', icon: 'none' })
  }
}
const recordCount = computed(
  () => data.value.tasks.length + data.value.notes.length + data.value.focus.length + data.value.news.length,
)
const dataKb = computed(() => {
  try {
    return Math.max(1, Math.round(JSON.stringify(data.value).length / 1024))
  } catch {
    return 0
  }
})

function toast(title: string): void {
  uni.showToast({ title, icon: 'none', duration: 1800 })
}

function pickSkin(mode: 'moss' | '550w'): void {
  if (state.skinMode === mode) return
  haptic('light')
  state.skinMode = mode
  markUserPreference('skin')
  toast(mode === 'moss' ? '已切换 MOSS 皮肤' : '已切换 550W 待机皮肤')
}

function pickLight(light: boolean): void {
  if (state.light === light) return
  haptic('light')
  state.light = light
  markUserPreference('light')
  toast(light ? '已切换浅色' : '已切换深色')
}

function cycleDevice(): void {
  const index = workDevices.value.findIndex((d) => d.id === work.deviceId)
  const next = workDevices.value[(index + 1) % workDevices.value.length]
  if (next === undefined) return
  haptic('light')
  switchDevice(next.id)
  toast(`已切到「${next.name}」的数据域`)
}

function go(url: string, label: string): void {
  haptic('light')
  uni.navigateTo({
    url,
    fail: () => toast(`${label}暂时打不开`),
  })
}

function placeholder(text: string): void {
  haptic('light')
  toast(text)
}
</script>

<template>
  <WorkShell active="mine" title="我的" :sub="`${deviceName()} · M1 本地版`">
    <view class="mine-page">
      <!-- 同步状态（M2 占位，但仍展示真实的待推/冲突数） -->
      <view class="sync-row" @tap="panelOpen = true">
        <view class="sync-icon"><text>⇅</text></view>
        <view class="sync-main">
          <view class="sync-t">
            <text>同步状态</text>
            <text class="sync-tag">{{ syncing ? '同步中' : (pending > 0 ? '待推送' : '已同步') }}</text>
          </view>
          <text class="sync-d">
            待推 <text class="sync-n mono">{{ pending }}</text> 条 · 冲突
            <text class="sync-n mono">{{ conflicts }}</text> 条 · {{ lastSyncText }}
          </text>
        </view>
        <text class="chev">›</text>
      </view>

      <!-- 外观 / 同步 / 数据 -->
      <view class="sect"><text>设置</text><text class="sect-n">即时生效</text></view>
      <view class="group">
        <view class="row">
          <view class="row-main">
            <text class="row-t">主题皮肤</text>
            <text class="row-d">MOSS 冷青绿 / 550W 待机红 · 同源令牌</text>
          </view>
          <view class="seg">
            <view class="seg-i" :class="{ on: activeSkin === 'moss' }" @tap="pickSkin('moss')">
              <text>MOSS</text>
            </view>
            <view class="seg-i" :class="{ on: activeSkin === '550w' }" @tap="pickSkin('550w')">
              <text>550W</text>
            </view>
          </view>
        </view>

        <view class="row">
          <view class="row-main">
            <text class="row-t">明暗</text>
            <text class="row-d">浅色下扫描线与发光自动关闭</text>
          </view>
          <view class="seg">
            <view class="seg-i" :class="{ on: !state.light }" @tap="pickLight(false)">
              <text>深色</text>
            </view>
            <view class="seg-i" :class="{ on: state.light }" @tap="pickLight(true)">
              <text>浅色</text>
            </view>
          </view>
        </view>

        <view class="row tap" @tap="placeholder('导出将在 M2 接入：任务 / 笔记 / 专注 / 资讯全量 JSON')">
          <view class="row-main">
            <text class="row-t">导出备份</text>
            <text class="row-d">全量 JSON 快照 · 可再导入或交给 AI 分析</text>
          </view>
          <text class="row-val">M2</text>
          <text class="chev">›</text>
        </view>

        <view class="row tap" @tap="placeholder('回收站将在 M2 接入：软删保留 30 天，可随时恢复')">
          <view class="row-main">
            <text class="row-t">回收站</text>
            <text class="row-d">软删保留 30 天 · 删除不静默丢失</text>
          </view>
          <text class="row-val">12 项</text>
          <text class="chev">›</text>
        </view>
      </view>

      <!-- 旧页入口 -->
      <view class="sect"><text>DSH Link 旧页</text><text class="sect-n">设备 / 会话</text></view>
      <view class="group">
        <view class="row tap" @tap="go('/pages/index/index', '设备配对')">
          <view class="row-main">
            <text class="row-t">设备配对</text>
            <text class="row-d">连接一台电脑上的 DSH 工作台 · 局域网 / 中继</text>
          </view>
          <text class="chev">›</text>
        </view>
        <view class="row tap" @tap="go('/pages/sessions/sessions', '会话列表')">
          <view class="row-main">
            <text class="row-t">会话列表</text>
            <text class="row-d">查看各设备上正在跑 / 等待审批的会话</text>
          </view>
          <text class="chev">›</text>
        </view>
      </view>

      <view class="foot-note">
        <text>
          M1 本地优先：任务 / 笔记 / 专注 / 资讯都离线可用；M2 接入 wb.* 同步后，
          与各台电脑上的 DSH 工作台双向同步，冲突默认保留两份。
        </text>
      </view>
    </view>

    <!-- 同步面板（P1-4） -->
    <view v-if="panelOpen" class="ov" @tap="panelOpen = false">
      <view class="ov-card" @tap.stop>
        <view class="ov-h">
          <text class="ov-t">同步 · {{ deviceName(work.deviceId) }}</text>
          <text class="ov-x" @tap="panelOpen = false">✕</text>
        </view>
        <view class="ov-kv"><text>待推送</text><text class="mono">{{ pending }} 条</text></view>
        <view class="ov-kv"><text>冲突</text><text class="mono">{{ conflicts }} 条</text></view>
        <view class="ov-kv"><text>上次同步</text><text class="mono">{{ lastSyncText }}</text></view>
        <view class="ov-kv"><text>游标</text><text class="mono">{{ stateOf(work.deviceId).cursor || '（首次全量）' }}</text></view>

        <view v-if="entityRows.length > 0" class="ov-sect">待推明细</view>
        <view v-for="r in entityRows" :key="r.name" class="ov-kv"><text>{{ r.name }}</text><text class="mono">{{ r.n }} 条</text></view>

        <view v-if="conflictNotes.length > 0" class="ov-sect">冲突副本（已保留，不会丢）</view>
        <view v-for="n in conflictNotes" :key="n.id" class="ov-note" @tap="openNotes">
          <text class="ov-note-t">{{ n.title }}</text>
          <text class="ov-note-s">点开笔记页处理</text>
        </view>

        <view v-if="syncStatus.lastError" class="ov-err">上次错误：{{ syncStatus.lastError }}</view>
        <view class="ov-btn" :class="{ busy: syncing }" @tap="doSync"><text>{{ syncing ? '同步中…' : '立即同步' }}</text></view>
        <view class="ov-hint">无连接或该设备未就绪时，数据只留在本机，不影响使用。</view>
      </view>
    </view>
  </WorkShell>
</template>

<style lang="scss" scoped>
.mine-page { padding-top: 2px; }

.device-card {
  padding: 16px;
  border-radius: var(--r-lg);
  border: 1px solid var(--bd);
  background: linear-gradient(135deg, var(--s1) 58%, var(--acc-soft));
}
.dc-top { display: flex; align-items: center; gap: 12px; }
.dc-av {
  position: relative;
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  display: grid;
  place-items: center;
  border-radius: 15px;
  border: 1px solid var(--bd-strong);
  background: var(--acc-soft);
  color: var(--acc);
}
.dc-glyph { font-size: 20px; line-height: 1; }
.dc-on {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--ok);
  border: 2px solid var(--s1);
}
.dc-on.off { background: var(--t3); }
.dc-main { flex: 1; min-width: 0; }
.dc-name-row { display: flex; align-items: center; gap: 8px; }
.dc-name { font-size: 16px; font-weight: 700; color: var(--t1); }
.badge {
  flex: 0 0 auto;
  font-size: 9.5px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 999px;
}
.badge.on { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }
.badge.mut { color: var(--t3); background: var(--s3); }
.dc-sub {
  display: block;
  margin-top: 3px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 10px;
  color: var(--t3);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dc-switch {
  flex: 0 0 auto;
  width: auto;
  min-height: 32px;
  height: 32px;
  padding: 0 12px;
  font-size: 11.5px;
}

.dc-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 14px;
}
.dc-stat {
  padding: 9px 10px;
  border-radius: 10px;
  background: var(--s2);
  border: 1px solid var(--bd);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ds-v { font-size: 16px; font-weight: 600; color: var(--acc); }
.ds-l { font-size: 9px; letter-spacing: 0.08em; color: var(--t3); }
.dc-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 10px;
  color: var(--t3);
}
.dc-dev { margin-left: auto; }

.sync-row {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: var(--r-md);
  background: var(--s1);
  border: 1px solid var(--bd);
}
.sync-row:active { border-color: var(--bd-strong); }
.sync-icon {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--acc-soft);
  color: var(--acc);
  font-size: 14px;
}
.sync-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.sync-t {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--t1);
}
.sync-tag {
  font-size: 9px;
  font-weight: 500;
  padding: 2px 6px;
  border-radius: 999px;
  color: var(--warn);
  background: var(--warn-soft);
}
.sync-d { font-size: 10.5px; line-height: 1.6; color: var(--t3); }
.sync-n { color: var(--t2); }
.chev { flex: 0 0 auto; color: var(--t3); font-size: 16px; line-height: 1; }

.sect {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
  margin: 18px 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1.4px;
  color: var(--t3);
}
.sect-n {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 9.5px;
  letter-spacing: 0;
}
.group {
  border: 1px solid var(--bd);
  border-radius: var(--r-lg);
  background: var(--s1);
  overflow: hidden;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 56px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--bd);
}
.row:last-child { border-bottom: 0; }
.row.tap:active { background: var(--s2); }
.row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.row-t { font-size: 13px; font-weight: 600; color: var(--t1); }
.row-d { font-size: 10px; line-height: 1.55; color: var(--t3); }
.row-val {
  flex: 0 0 auto;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 10px;
  color: var(--t3);
}
.seg {
  flex: 0 0 auto;
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: var(--s2);
  border: 1px solid var(--bd);
}
.seg-i {
  padding: 5px 9px;
  border-radius: 7px;
  font-size: 10.5px;
  color: var(--t2);
  transition: background 160ms var(--ease-out), color 160ms var(--ease-out);
}
.seg-i.on {
  background: var(--acc);
  color: var(--acc-ink);
  font-weight: 600;
}

.foot-note {
  margin-top: 14px;
  padding: 14px;
  border-radius: var(--r-md);
  border: 1px dashed var(--bd);
  font-size: 10.5px;
  line-height: 1.85;
  color: var(--t3);
}

@media (min-width: 820px) {
  .device-card { padding: 18px; }
  .dc-stats { gap: 10px; }
  .row { padding: 12px 16px; }
}
.ov {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(6, 14, 10, 0.48);
  display: flex;
  align-items: flex-end;
}
.ov-card {
  width: 100%;
  max-height: 82vh;
  overflow-y: auto;
  background: var(--s1);
  border-top-left-radius: var(--r-lg);
  border-top-right-radius: var(--r-lg);
  border: 1px solid var(--bd);
  padding: 16px 18px calc(20px + env(safe-area-inset-bottom));
}
.ov-h { display: flex; align-items: center; margin-bottom: 10px; }
.ov-t { flex: 1; font-size: 14px; font-weight: 650; }
.ov-x { font-size: 14px; color: var(--t3); padding: 4px 6px; }
.ov-kv { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; font-size: 12px; color: var(--t2); border-bottom: 1px solid var(--s3); }
.ov-sect { margin: 14px 0 4px; font-size: 11px; letter-spacing: 0.06em; color: var(--t3); }
.ov-note { margin-top: 8px; padding: 10px 12px; border-radius: var(--r-md); background: var(--warn-soft); border: 1px solid var(--bd); }
.ov-note-t { display: block; font-size: 12px; color: var(--t1); }
.ov-note-s { display: block; margin-top: 3px; font-size: 10.5px; color: var(--t3); }
.ov-err { margin-top: 10px; font-size: 10.5px; color: var(--danger); line-height: 1.6; }
.ov-btn { margin-top: 16px; height: 44px; border-radius: var(--r-md); background: var(--acc); color: var(--acc-ink); display: flex; align-items: center; justify-content: center; font-size: 13.5px; font-weight: 650; }
.ov-btn.busy { opacity: 0.6; }
.ov-hint { margin-top: 10px; font-size: 10.5px; color: var(--t3); line-height: 1.7; }
</style>
