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

onMounted(() => normalizeDevice())

const syncText = computed(() => `${currentDevice.value.online ? '已同步' : '离线'} · ${deviceName()}`)
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
        <view class="ws-sync" :class="{ off: !currentDevice.online }">
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
