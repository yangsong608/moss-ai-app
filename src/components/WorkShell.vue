<script setup lang="ts">
/**
 * 工作台外壳：顶栏（设备域 / 同步 / 主题）+ 导航 + 内容。
 *
 * 布局：
 *   - 手机（<900）：导航在底部，内容占满
 *   - 平板/横屏（>=900）：导航变左侧竖栏，内容区右侧自适应（Y700 横屏 1280×800 落这档）
 *
 * 约定沿用 core/store 的皮肤与明暗；图标用文本字形（App 端内联 SVG 不稳）。
 */
import { computed, onMounted } from 'vue'
import { skinClass, themeClass, state } from '@/core/store'
import { workDevices, work, switchDevice, normalizeDevice } from '@/core/workbench'
import { syncStatus } from '@/core/sync-queue'
import { startAutoSync } from '@/core/sync-engine'
import { haptic } from '@/core/haptic'

const props = defineProps<{
  active: 'today' | 'calendar' | 'notes' | 'focus' | 'news' | 'sessions' | 'mine'
  title: string
  sub?: string
}>()

const rootClass = computed(() => ['dsh', 'ws', skinClass.value, themeClass.value])

/** key 同时用于高亮；url 单独给（sessions 页不在同名目录） */
const TABS = [
  { key: 'today', label: '今天', glyph: '✓', url: '/pages/today/today' },
  { key: 'calendar', label: '日历', glyph: '▦', url: '/pages/calendar/calendar' },
  { key: 'notes', label: '笔记', glyph: '▤', url: '/pages/notes/notes' },
  { key: 'focus', label: '专注', glyph: '◷', url: '/pages/focus/focus' },
  { key: 'news', label: '资讯', glyph: '▥', url: '/pages/news/news' },
  { key: 'sessions', label: '会话', glyph: '❯', url: '/pages/sessions/sessions' },
  { key: 'mine', label: '我的', glyph: '☰', url: '/pages/mine/mine' },
] as const

const currentDevice = computed(() => workDevices.value.find((d) => d.id === work.deviceId) ?? workDevices.value[0])

onMounted(() => {
  normalizeDevice()
  startAutoSync()
})

function go(t: (typeof TABS)[number]): void {
  if (t.key === props.active) return
  haptic('light')
  uni.reLaunch({ url: t.url })
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

const syncText = computed(() => {
  const base = currentDevice.value?.online ? '已同步' : '离线'
  const extra = syncStatus.pending > 0 ? ` · 待推 ${syncStatus.pending}` : ''
  const warn = syncStatus.conflicts > 0 ? ` · 冲突 ${syncStatus.conflicts}` : ''
  return `${base}${extra}${warn}`
})
</script>

<template>
  <view :class="rootClass">
    <!-- 导航（手机底部 / 平板左侧） -->
    <view class="ws-nav">
      <view
        v-for="t in TABS"
        :key="t.key"
        class="ws-tab"
        :class="{ on: props.active === t.key }"
        @tap="go(t)"
      >
        <text class="ws-glyph">{{ t.glyph }}</text>
        <text class="ws-label">{{ t.label }}</text>
      </view>
    </view>

    <view class="ws-main">
      <!-- 顶栏 -->
      <view class="ws-top safe-top">
        <view class="ws-title">
          <text class="ws-t">{{ props.title }}</text>
          <text v-if="props.sub" class="ws-s">{{ props.sub }}</text>
        </view>
        <view class="ws-actions">
          <view class="ws-sync" :class="{ off: !currentDevice?.online, alert: syncStatus.conflicts > 0 }">
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

/* ── 导航：手机在底部 ── */
.ws-nav {
  order: 2;
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  background: color-mix(in srgb, var(--s1) 94%, transparent);
  border-top: 1px solid var(--bd);
}
.ws-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 7px 0 5px;
  color: var(--t3);
  min-width: 0;
}
.ws-tab.on { color: var(--acc); }
.ws-glyph { font-size: 14px; line-height: 1; }
.ws-label { font-size: 9.5px; letter-spacing: 0.01em; white-space: nowrap; }
.ws-tab.on .ws-label { font-weight: 600; }

.ws-main { order: 1; flex: 1; min-height: 0; display: flex; flex-direction: column; }

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
  white-space: nowrap;
}
.ws-sync.off { color: var(--t3); }
.ws-sync.alert { border-color: color-mix(in srgb, var(--warn) 46%, transparent); color: var(--warn); }
.ws-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.ws-sync.off .ws-dot { background: var(--t3); }
.ws-sync.alert .ws-dot { background: var(--warn); }
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

/* ── 平板：左侧竖栏导航 ──
 * 断点取「宽 ≥760 且 高 ≥520」而不是单纯 900：
 *   · 联想 Y700 8.8" 2560×1600 @DPR2 = 1280×800 CSS —— 横竖屏都落这档
 *   · 手机横屏 844×390（高 390 < 520）仍走底部导航，不会被误判成平板
 */
@media (min-width: 760px) and (min-height: 520px) {
  .ws { flex-direction: row; }
  .ws-nav {
    order: 0;
    flex: 0 0 84px;
    width: 84px;
    flex-direction: column;
    justify-content: flex-start;
    gap: 2px;
    padding: 14px 0;
    border-top: 0;
    border-right: 1px solid var(--bd);
  }
  .ws-tab {
    flex: 0 0 auto;
    width: 64px;
    margin: 2px auto;
    padding: 9px 0;
    border-radius: var(--r-md);
    gap: 3px;
  }
  .ws-tab.on { background: var(--acc-soft); }
  .ws-glyph { font-size: 16px; }
  .ws-label { font-size: 10.5px; }

  .ws-main { order: 1; }
  .ws-top { padding: 16px 24px 8px; }
  .ws-devs { padding: 2px 0 8px; }
  .ws-devrow { padding: 0 24px; }
  .ws-inner { max-width: 1180px; margin: 0 auto; padding: 8px 24px 28px; }
}
</style>
