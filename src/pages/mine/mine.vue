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
import MossTex from '@/components/moss/MossTex.vue'
import MossIcon from '@/components/moss/MossIcon.vue'
import { deviceName, domainStats, isLocalDomain, uploadLocalTo, useWork, work, workDevices } from '@/core/workbench'
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
const localOnly = computed(() => isLocalDomain())
const online = computed(() => localOnly.value || currentDevice.value?.online === true)
const todayFocusMinutes = computed(() => {
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  return data.value.focus
    .filter((session) => session.startedAt >= day.getTime())
    .reduce((sum, session) => sum + session.minutes, 0)
})
const statusText = computed(() => {
  if (localOnly.value) return '本机存储'
  return online.value ? '设备在线' : '设备离线'
})
const statusSubtitle = computed(() => {
  if (localOnly.value) return '本地域不联网，任务、笔记与专注始终可用'
  if (!online.value) return '当前离线，任务、笔记与专注仍可在本机使用'
  return '设备链路在线，本地数据可与工作台保持同步'
})

/** 本地域 → 上传到某台设备（只增不覆盖） */
function uploadTo(): void {
  const targets = workDevices.value.filter((d) => !d.local)
  if (targets.length === 0) {
    uni.showToast({ title: '还没有已配对的设备', icon: 'none' })
    return
  }
  uni.showActionSheet({
    itemList: targets.map((d) => d.name),
    success: (res) => {
      const target = targets[res.tapIndex]
      if (target === undefined) return
      const r = uploadLocalTo(target.id)
      uni.showToast({
        title: `已上传 任务${r.tasks} 笔记${r.notes} 专注${r.focus}`,
        icon: 'none',
      })
    },
  })
}

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
      <view class="mine-aurora aurora-a" />
      <view class="mine-aurora aurora-b" />

      <!-- 当前域控制台摘要：只读现有数据，不新增设备或数据层状态。 -->
      <view class="console-card fb-enter-card">
        <MossTex name="console" />
        <view class="console-top">
          <view class="domain-mark"><text class="mono">{{ localOnly ? 'L' : 'M' }}</text></view>
          <view class="domain-main">
            <view class="domain-line">
              <text class="domain-name">{{ deviceName() }}</text>
              <text class="domain-badge">{{ localOnly ? '本地域' : '当前设备' }}</text>
            </view>
            <text class="domain-sub mono">{{ localOnly ? 'LOCAL DOMAIN / OFFLINE FIRST' : (currentDevice?.sub || 'DEVICE DOMAIN / DSH LINK') }}</text>
          </view>
          <view class="domain-status" :class="{ off: !online }">
            <view class="status-beacon"><view v-if="online" class="status-radar" /><view class="status-core" /></view>
            <text>{{ statusText }}</text>
          </view>
        </view>
        <view class="console-stats">
          <view class="console-stat">
            <text class="console-value mono">{{ stats.total }}</text>
            <text class="console-label">任务数</text>
          </view>
          <view class="console-stat">
            <text class="console-value mono">{{ data.notes.length }}</text>
            <text class="console-label">笔记数</text>
          </view>
          <view class="console-stat">
            <text class="console-value mono">{{ todayFocusMinutes }}</text>
            <text class="console-label">今日专注分钟</text>
          </view>
        </view>
        <view class="console-foot">
          <text class="console-caption">{{ statusSubtitle }}</text>
          <text class="console-live mono">{{ localOnly ? 'LOCAL' : (online ? 'LIVE' : 'CACHED') }}</text>
        </view>
      </view>

      <view v-if="localOnly" class="local-card fb-enter-card fb-i-1">
        <MossTex name="local" />
        <view class="local-icon"><MossIcon name="device" :size="19" /></view>
        <view class="local-copy">
          <text class="local-title">本地域 · 不联网</text>
          <text class="local-desc">内容只保存在本机，可只增不覆盖地上传到设备</text>
        </view>
        <view class="local-upload fb-press" @tap="uploadTo"><text>上传到设备</text><MossIcon class="local-arrow" name="send" :size="12" /></view>
      </view>

      <!-- 同步状态（M2 占位，但仍展示真实的待推/冲突数） -->
      <view class="sync-row glass-card fb-enter-card fb-i-2" @tap="panelOpen = true">
        <MossTex name="sync" />
        <view class="sync-icon"><MossIcon name="sync" :size="19" /></view>
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
        <MossIcon class="chev" name="chev" :size="14" />
      </view>

      <!-- 外观 / 同步 / 数据 -->
      <view class="sect"><text>设置</text><text class="sect-n">即时生效</text></view>
      <view class="group glass-card fb-enter-card fb-i-3">
        <view class="row tap">
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

        <view class="row tap">
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
          <MossIcon class="chev" name="chev" :size="14" />
        </view>

        <view class="row tap" @tap="placeholder('回收站将在 M2 接入：软删保留 30 天，可随时恢复')">
          <view class="row-main">
            <text class="row-t">回收站</text>
            <text class="row-d">软删保留 30 天 · 删除不静默丢失</text>
          </view>
          <text class="row-val">12 项</text>
          <MossIcon class="chev" name="chev" :size="14" />
        </view>
      </view>

      <!-- 旧页入口 -->
      <view class="sect"><text>DSH Link 旧页</text><text class="sect-n">设备 / 会话</text></view>
      <view class="group glass-card fb-enter-card fb-i-4">
        <view class="row tap" @tap="go('/pages/index/index', '设备配对')">
          <view class="row-main">
            <text class="row-t">设备配对</text>
            <text class="row-d">连接一台电脑上的 DSH 工作台 · 局域网 / 中继</text>
          </view>
          <MossIcon class="chev" name="chev" :size="14" />
        </view>
        <view class="row tap" @tap="go('/pages/sessions/sessions', '会话列表')">
          <view class="row-main">
            <text class="row-t">会话列表</text>
            <text class="row-d">查看各设备上正在跑 / 等待审批的会话</text>
          </view>
          <MossIcon class="chev" name="chev" :size="14" />
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
      <!-- 外层 shell 负责裁切与纹理，内层才滚动 —— 否则纹理会跟着内容滚走 -->
      <view class="ov-shell" @tap.stop>
        <MossTex name="ovcard" fit="contain" />
        <view class="ov-card">
          <view class="ov-h">
            <text class="ov-t">同步 · {{ deviceName(work.deviceId) }}</text>
            <view class="ov-x" @tap="panelOpen = false"><MossIcon name="close" :size="13" /></view>
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
    </view>
  </WorkShell>
</template>

<style lang="scss" scoped>
.mine-page {
  position: relative;
  padding-top: 2px;
  --console-glass: color-mix(in srgb, var(--s1) 80%, transparent);
  --console-glass-low: color-mix(in srgb, var(--s2) 62%, transparent);
  --console-highlight: color-mix(in srgb, var(--t1) 9%, transparent);
  --console-shadow: 0 10px 28px color-mix(in srgb, var(--bg-grad-3) 12%, transparent);
}
.is-light .mine-page {
  --console-glass: color-mix(in srgb, var(--s1) 84%, transparent);
  --console-glass-low: color-mix(in srgb, var(--s1) 68%, transparent);
  --console-highlight: color-mix(in srgb, var(--s1) 94%, transparent);
  --console-shadow: 0 10px 28px color-mix(in srgb, var(--bg-grad-3) 8%, transparent);
}
.mine-aurora {
  position: absolute;
  z-index: 0;
  left: -12%;
  width: 124%;
  height: 330px;
  pointer-events: none;
  background:
    radial-gradient(ellipse at 28% 36%, var(--acc-soft), transparent 58%),
    radial-gradient(ellipse at 78% 54%, var(--acc-glow), transparent 55%);
  opacity: 0.55;
  animation: mine-aurora 24s ease-in-out infinite alternate;
}
.aurora-a { top: -90px; }
.aurora-b { top: 190px; opacity: 0.28; animation-direction: alternate-reverse; }
.is-light .mine-aurora { opacity: 0.2; }
@keyframes mine-aurora {
  from { transform: translate3d(-3%, -2%, 0); }
  to { transform: translate3d(3%, 2%, 0); }
}
.glass-card,
.console-card {
  position: relative;
  z-index: 1;
  border: 1px solid var(--bd);
  border-radius: 20px;
  background:
    linear-gradient(125deg, var(--console-highlight), transparent 34%),
    linear-gradient(155deg, var(--console-glass), var(--console-glass-low));
  box-shadow: var(--console-shadow), inset 0 1px 0 var(--console-highlight);
  transition: transform 120ms ease-out, border-color 160ms ease-out, background-color 160ms ease-out;
}
.console-card { overflow: hidden; padding: 16px 16px 0; }
/* 控制台内容压在纹理之上 */
.console-card > .console-top,
.console-card > .console-stats,
.console-card > .console-foot {
  position: relative;
  z-index: 1;
}
.console-top { display: flex; align-items: center; gap: 11px; min-width: 0; }
.domain-mark {
  flex: none;
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border: 1px solid var(--bd-strong);
  border-radius: 14px;
  background: var(--acc-soft);
  color: var(--acc);
  font-size: 17px;
  font-weight: 700;
  box-shadow: inset 0 1px 0 var(--console-highlight);
}
.domain-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.domain-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
.domain-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--t1); font-size: 15px; font-weight: 650; }
.domain-badge { flex: none; padding: 2px 6px; border: 1px solid var(--bd); border-radius: 5px; background: var(--acc-soft); color: var(--acc); font-size: 8px; letter-spacing: 0.4px; }
.domain-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--t3); font-size: 7.5px; letter-spacing: 0.7px; }
.domain-status { flex: none; display: flex; align-items: center; gap: 6px; color: var(--acc); font-size: 9px; white-space: nowrap; }
.domain-status.off { color: var(--t3); }
.status-beacon { position: relative; width: 10px; height: 10px; display: grid; place-items: center; }
.status-core { position: relative; z-index: 1; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-radar { position: absolute; width: 9px; height: 9px; border: 1px solid currentColor; border-radius: 50%; animation: mine-radar 1.8s ease-out infinite; }
@keyframes mine-radar {
  0% { opacity: 0.5; transform: scale(1); }
  85%, 100% { opacity: 0; transform: scale(1.9); }
}
.console-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 18px; padding: 15px 0; border-top: 1px solid var(--bd); border-bottom: 1px solid var(--bd); background: linear-gradient(90deg, transparent, var(--acc-soft), transparent); }
.console-stat { min-width: 0; display: flex; flex-direction: column; gap: 6px; padding-left: 14px; border-left: 1px solid var(--bd); }
.console-stat:first-child { padding-left: 0; border-left: 0; }
.console-value { color: var(--t1); font-size: 28px; font-weight: 550; line-height: 1; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
.console-label { color: var(--t3); font-size: 9px; white-space: nowrap; }
.console-foot { display: flex; align-items: center; gap: 10px; min-height: 47px; }
.console-caption { flex: 1; min-width: 0; color: var(--t2); font-size: 10px; line-height: 1.6; }
.console-live { flex: none; color: var(--t3); font-size: 7px; letter-spacing: 1px; }
.local-card {
  position: relative;
  z-index: 1;
  overflow: hidden;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 11px;
  margin-top: 12px;
  padding: 14px;
  border: 1px dashed var(--bd-strong);
  border-radius: 20px;
  background: linear-gradient(145deg, var(--console-glass-low), var(--acc-soft));
  box-shadow: var(--console-shadow);
}
.local-icon { flex: none; width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid var(--bd); border-radius: 12px; background: var(--acc-soft); }
.local-copy { flex: 1; min-width: 180px; display: flex; flex-direction: column; gap: 4px; }
.local-title { color: var(--t1); font-size: 13px; font-weight: 650; }
.local-desc { color: var(--t2); font-size: 10px; line-height: 1.6; }
.local-upload { flex: none; min-height: 38px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 13px; border: 1px solid var(--bd-strong); border-radius: 12px; background: var(--acc-soft); color: var(--acc); font-size: 11px; font-weight: 650; }
.local-arrow { flex: none; }
/* 本地域卡内容压在纹理之上 */
.local-card > .local-icon,
.local-card > .local-copy,
.local-card > .local-upload {
  position: relative;
  z-index: 1;
}

.sync-row {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: 11px;
  margin-top: 12px;
  padding: 14px;
}
/* 同步行内容压在纹理之上 */
.sync-row > .sync-icon,
.sync-row > .sync-main {
  position: relative;
  z-index: 1;
}
.sync-row:hover { transform: translateY(-1px); border-color: var(--bd-strong); }
.sync-row:active { transform: scale(0.99); border-color: var(--bd-strong); }
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
.chev { flex: 0 0 auto; opacity: 0.6; }

.sect {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
  position: relative;
  z-index: 1;
  margin: 20px 0 9px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.65px;
  color: var(--t3);
}
.sect-n {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 9.5px;
  letter-spacing: 0;
}
.group { overflow: hidden; }
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 56px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--bd);
  transition: transform 120ms ease-out, background-color 160ms ease-out;
}
.row:last-child { border-bottom: 0; }
.row.tap:hover { background: var(--acc-soft); transform: translateY(-1px); }
.row.tap:active { background: var(--acc-soft); transform: scale(0.99); }
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
  transition: transform 90ms ease-out, background-color 160ms var(--ease-out), color 160ms var(--ease-out), border-color 160ms var(--ease-out);
}
.seg-i.on {
  background: var(--acc);
  color: var(--acc-ink);
  font-weight: 600;
}

.foot-note {
  position: relative;
  z-index: 1;
  margin-top: 14px;
  padding: 14px;
  border-radius: var(--r-md);
  border: 1px dashed var(--bd);
  font-size: 10.5px;
  line-height: 1.85;
  color: var(--t3);
}

@media (min-width: 820px) {
  .console-card { padding: 20px 20px 0; }
  .console-stats { margin-top: 22px; }
  .row { padding: 13px 16px; }
}
@media (max-width: 420px) {
  .console-card { padding: 14px 14px 0; }
  .console-top { flex-wrap: wrap; }
  .domain-status { margin-left: 53px; margin-top: -5px; }
  .console-value { font-size: 26px; }
  .local-copy { min-width: calc(100% - 49px); }
  .local-upload { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .mine-aurora, .status-radar { display: none; }
}
.ov {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(6, 14, 10, 0.48);
  display: flex;
  align-items: flex-end;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
/* 外层 shell：负责定位、裁切与承载纹理 */
.ov-shell {
  position: relative;
  overflow: hidden;
  width: 100%;
  max-height: 88vh;
  max-height: 88dvh;
  /* 底色放 shell 上：内容卡必须透明，否则它连背景一起把纹理盖死
     （今天页 .menu-shell 的正确模式——shell 出底、内容层只放文字） */
  background: var(--s1);
  border: 1px solid var(--bd);
  border-top-left-radius: var(--r-lg);
  border-top-right-radius: var(--r-lg);
}
/* 弹层内容压在纹理之上 */
.ov-shell > .ov-card { position: relative; z-index: 1; }
.ov-card {
  width: 100%;
  max-height: 88vh;
  max-height: 88dvh;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;  overscroll-behavior: contain;
  background: transparent;
  border: 0;
  padding: 16px 18px calc(20px + env(safe-area-inset-bottom));
}
.ov-h { display: flex; align-items: center; margin-bottom: 10px; }
.ov-t { flex: 1; font-size: 14px; font-weight: 650; }
.ov-x { display: grid; place-items: center; padding: 4px 6px; }
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
