<script setup lang="ts">
/**
 * 「← 工作台」返回条（旧页 / 对话页共用，P2-3）。
 *
 * 旧页仍在 PageShell 的 3+1 Tab 体系里，进得去回不到 6 Tab 新壳；
 * 这条返回条是两种外壳之间唯一的出口，所以做成独立组件：
 * 会话页与对话页共用一份样式，避免"两个页面各写一版，颜色越走越偏"。
 *
 * 用 reLaunch 而不是 navigateBack：入口可能来自我的页 / 系统分享 / 冷启动，
 * 页面栈里未必有下一页可退；reLaunch 总能落到今天页。
 */
import { haptic } from '@/core/haptic'

const props = defineProps<{
  /** 左侧按钮文案，默认「工作台」 */
  label?: string
  /** 右侧提示，说明返回后到哪 */
  hint?: string
}>()

function back(): void {
  haptic('light')
  uni.reLaunch({ url: '/pages/today/today' })
}
</script>

<template>
  <view class="backbar">
    <view class="bb-hit" hover-class="bb-hover" @tap="back">
      <view class="bb-chev" />
      <text class="bb-t">{{ props.label ?? '工作台' }}</text>
    </view>
    <text v-if="props.hint" class="bb-hint">{{ props.hint }}</text>
  </view>
</template>

<style lang="scss" scoped>
/* 与 WorkShell 的浅色卡片观感对齐：var() 令牌 + 细边 + 圆角。 */
.backbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  margin: 6px 12px 2px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--bd);
  background: var(--s1);
}

.bb-hit {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 100%;
  padding-right: 6px;
}

.bb-hover { opacity: 0.65; }

/* 左箭头：只留左/下两条边，旋转 45°（App 端内联 SVG 不稳，统一用 CSS 画） */
.bb-chev {
  width: 8px;
  height: 8px;
  border-left: 2px solid var(--t2);
  border-bottom: 2px solid var(--t2);
  transform: rotate(45deg);
  flex: none;
}

.bb-t {
  font-size: 12px;
  font-weight: 600;
  color: var(--t1);
  letter-spacing: 0.2px;
}

.bb-hint {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 10px;
  color: var(--t3);
}
</style>
