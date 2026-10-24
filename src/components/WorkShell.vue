<script setup lang="ts">
/**
 * 工作台外壳（五屏共用）：顶栏（设备域 + 同步状态 + 皮肤）+ 底部 6 Tab。
 *
 * 约定：
 *   - 沿用 core/store 的皮肤/明暗（skinClass / themeClass），页面内不写死色值
 *   - uni-app App 端内联 SVG 不稳，图标用文本字形 + CSS 形状
 *   - 切 Tab 用 reLaunch（避免页面栈越叠越深）
 */
import { computed, onMounted } from 'vue'
import { skinClass, themeClass, state, skin } from '@/core/store'
import { workDevices, work, switchDevice, deviceName, normalizeDevice } from '@/core/workbench'
import { syncStatus } from '@/core/sync-queue'
import { startAutoSync, syncNow } from '@/core/sync-engine'
import { haptic } from '@/core/haptic'

const props = defineProps<{
  active: 'today' | 'calendar' | 'notes' | 'focus' | 'news' | 'mine'
  title: string
  sub?: string
}>()

const rootClass = computed(() => ['dsh', 'ws', skinClass.value, themeClass.value])

const TABS = [
  { key: 'today', label: '今天', glyph: '✓' },
  { key: 'calendar', label: '日历', glyph: '▦' },
  { key: 'notes', label: '笔记', glyph: '▤' },
  { key: 'focus', label: '专注', glyph: '◷' },
  { key: 'news', label: '资讯', glyph: '▥' },
  { key: 'mine', label: '我的', glyph: '☰' },
] as const

const currentDevice = computed(() => workDevices.value.find((d) => d.id === work.deviceId) ?? workDevices.value[0])

function go(key: string): void {
  if (key === props.active) return
  haptic('light')
  uni.reLaunch({ url: `/pages/${key}/${key}` })
}

function pick(device: string): void {
  if (device === work.deviceId) return
  haptic('light')
  switchDevice(device)
}

function toggleTheme(): void {
  state.light = !state.light
  haptic('light')
}

onMounted(() => {
  normalizeDevice()
  // 幂等：首个挂载起 30s 定时 + 网络恢复/回前台触发；每次挂载（= 切 Tab）也同步一次
  startAutoSync()
})

/**
 * 顶栏同步徽标：优先暴露"待推 / 冲突"（有活要干时状态比"已同步"更有信息量）。
 * syncing 期间显示"同步中"，失败后回落到设备在线态（错误明细在 syncStatus.lastError）。
 */
const syncText = computed(() => {
  if (syncStatus.syncing) return `同步中 · ${deviceName()}`
  const pending: string[] = []
  if (syncStatus.pending > 0) pending.push(`待推 ${syncStatus.pending}`)
  if (syncStatus.conflicts > 0) pending.push(`冲突 ${syncStatus.conflicts}`)
  if (pending.length > 0) return `${pending.join(' · ')} · ${deviceName()}`
  if (syncStatus.lastError !== '') return `同步异常 · ${deviceName()}`
  return `${currentDevice.value.online ? '已同步' : '离线'} · ${deviceName()}`
})

const syncOffline = computed(() => !currentDevice.value.online || syncStatus.lastError !== '')

/** 点徽标：手动同步一次，结果用 toast 反馈（成功 / 离线 / 冲突 / 失败） */
async function tapSync(): Promise<void> {
  if (syncStatus.syncing) return
  haptic('light')
  const result = await syncNow()
  if (result.ok) {
    const conflicts = result.conflicts ?? 0
    if (conflicts > 0) {
      uni.showToast({ title: `已同步，${conflicts} 条冲突待处理`, icon: 'none', duration: 2200 })
      return
    }
    const pushed = result.pushed ?? 0
    uni.showToast({ title: pushed > 0 ? `已同步，推送 ${pushed} 条` : '已是最新', icon: 'none', duration: 1600 })
    return
  }
  if (result.reason === 'offline') {
    uni.showToast({ title: '离线：尚未连接主机', icon: 'none', duration: 2000 })
    return
  }
  if (result.reason === 'busy') return
  uni.showToast({ title: `同步失败：${(result.error ?? '未知错误').slice(0, 24)}`, icon: 'none', duration: 2400 })
}
</script>

<template>
  <view :class="rootClass">
    <!-- 顶栏 -->
    <view class="ws-top safe-top">
      <view class="ws-title">
        <text class="ws-t">{{ props.title }}</text>
        <text v-if="props.sub" class="ws-s">{{ props.sub }}</text>
      </view>
      <view class="ws-actions">
        <view
          class="ws-sync"
          :class="{ off: syncOffline, busy: syncStatus.syncing, alert: syncStatus.conflicts > 0 }"
          @tap="tapSync"
        >
          <view class="ws-dot" />
          <text>{{ syncText }}</text>
        </view>
        <view class="ws-theme" @tap="toggleTheme">
          <text>{{ state.light ? '☾' : '☀' }}</text>
        </view>
      </view>
    </view>

    <!-- 设备域切换 -->
    <scroll-view scroll-x class="ws-devs" :show-scrollbar="false">
      <view class="ws-devrow">
        <view
          v-for="d in workDevices"
          :key="d.id"
          class="ws-dev"
          :class="{ on: d.id === work.deviceId, local: d.local }"
          @tap="pick(d.id)"
        >
          <view class="ws-devdot" :class="{ off: !d.online }" />
          <text class="ws-devname">{{ d.name }}</text>
        </view>
      </view>
    </scroll-view>

    <!-- 内容 -->
    <scroll-view scroll-y class="ws-body">
      <view class="ws-inner">
        <slot />
      </view>
    </scroll-view>

    <!-- 底部 6 Tab -->
    <view class="ws-tabbar safe-bottom">
      <view
        v-for="t in TABS"
        :key="t.key"
        class="ws-tab"
        :class="{ on: props.active === t.key }"
        @tap="go(t.key)"
      >
        <text class="ws-glyph">{{ t.glyph }}</text>
        <text class="ws-label">{{ t.label }}</text>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.ws {
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg-grad-1, var(--bg));
  color: var(--t1);
}

.ws-top {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px 8px;
}
.ws-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ws-t { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
.ws-s { font-size: 11px; color: var(--t3); }
.ws-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.ws-sync {
  display: flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px; border-radius: 999px;
  background: var(--s1); border: 1px solid var(--bd); font-size: 10.5px; color: var(--t2);
}
.ws-sync.off { color: var(--t3); }
.ws-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.ws-sync.off .ws-dot { background: var(--t3); }
/* 冲突 / 同步中给一点视觉差：徽标可点，状态要能被一眼看出来 */
.ws-sync.alert { color: var(--warn); border-color: var(--bd-strong); }
.ws-sync.alert .ws-dot { background: var(--warn); }
.ws-sync.busy .ws-dot { background: var(--acc); animation: ws-pulse 1s ease-in-out infinite; }
.ws-sync:active { border-color: var(--bd-strong); opacity: 0.85; }
@keyframes ws-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
.ws-theme {
  width: 34px; height: 34px; border-radius: 12px; display: grid; place-items: center;
  background: var(--s1); border: 1px solid var(--bd); font-size: 15px; color: var(--t2);
}

.ws-devs { flex: 0 0 auto; white-space: nowrap; padding: 2px 0 6px; }
.ws-devrow { display: flex; gap: 8px; padding: 0 18px; }
.ws-dev {
  display: inline-flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 12px; border-radius: 999px;
  background: var(--s1); border: 1px solid var(--bd); color: var(--t2); font-size: 11.5px;
}
.ws-dev.on { background: var(--acc-soft); border-color: var(--bd-strong); color: var(--acc); }
.ws-dev.local { border-style: dashed; }
.ws-devdot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.ws-devdot.off { background: var(--t3); }
.ws-devname { font-weight: 500; }

.ws-body { flex: 1; min-height: 0; }
.ws-inner { padding: 6px 16px 24px; }
@media (min-width: 820px) {
  .ws-inner { max-width: 1120px; margin: 0 auto; padding: 10px 24px 28px; }
}

.ws-tabbar {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  background: color-mix(in srgb, var(--s1) 92%, transparent);
  border-top: 1px solid var(--bd);
}
.ws-tab {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; padding: 8px 0 6px; color: var(--t3);
}
.ws-tab.on { color: var(--acc); }
.ws-glyph { font-size: 15px; line-height: 1; }
.ws-label { font-size: 10px; letter-spacing: 0.02em; }
.ws-tab.on .ws-label { font-weight: 600; }
</style>
