<script setup lang="ts">
/**
 * MOSS 线稿图标。
 *
 * ## 为什么要把图标也换成图
 *
 * 改之前项目里有三套并行的图标实现，全都有问题：
 *   1. **Unicode 文本符号**（✓ ▦ ◷ ☀ ⇅ ⌁ 🔔 …）。字体取决于用户系统，
 *      App 端和微信小程序端渲染各不相同，🔔 这种直接变成彩色 emoji，
 *      和整套冷青绿界面完全不搭。
 *   2. **CSS 画的小色块**（.empty-signal / .local-glyph / .ico-stop）。
 *      一堆前缀写法，圆角和对齐在各端有偏差，且改不动细节。
 *   3. **预渲染 3D 图**（badge-idle / badge-work / hero.webp）。
 *      风格是写实渲染，和现在的线稿体系完全脱节。
 *
 * 现在统一走 <image>：主图是黑底发光线稿，构建时按"亮度当 alpha"抠出，
 * 再按四套主题重新上色（tools/moss-render/icons.py），
 * 所以图标和卡片纹理在任何主题下都是同一个色系。
 *
 * ## 为什么不和 MossTex 合并
 *
 * MossTex 是"铺满容器"的纹理层（scaleToFill + opacity 令牌 + lite 降级）；
 * 图标是"固定正方形画布"的功能性图形，需要尺寸、需要翻转、
 * 低端机上也不能消失。两者生命周期不同，分开更清楚。
 */
import { computed } from 'vue'
import { skinClass, themeClass } from '@/core/store'

/**
 * 图标清单。与 tools/moss-render/raw-icons/ 下的主图一一对应。
 *
 *   check     完成 / 今天 tab        cal       日历 tab
 *   note      笔记 tab              clock     专注 tab / 待办
 *   feed      资讯 tab              chat      会话 tab
 *   menu      我的 tab              device    设备 / 本机
 *   refresh   重连 / 刷新           sun/moon  明暗切换
 *   search    搜索                  plus      新建
 *   close     关闭                  stop      停止
 *   send      发送                  alert     异常
 *   sync      同步状态              pair      配对
 *   signal    信号强度              scan      扫码
 *   file/folder 文件 / 目录         star      收藏 / 星标
 *   bell      提醒                  chev      前进（flip 后为后退）
 *   badge     状态角标              hero      品牌图
 *
 * 清单与 src/static/moss/icon/ 下的资产一一对应；
 * 加图标名必须同时加资产，否则运行时会 404。
 */
type IconName =
  | 'alert' | 'badge' | 'bell' | 'cal' | 'chat' | 'check' | 'chev' | 'clock'
  | 'close' | 'device' | 'feed' | 'file' | 'folder' | 'hero'
  | 'menu' | 'moon' | 'note' | 'pair' | 'plus' | 'refresh' | 'scan' | 'search'
  | 'send' | 'signal' | 'star' | 'stop' | 'sun' | 'sync'

const props = withDefaults(
  defineProps<{
    /** 图标名。 */
    name: IconName
    /** 显示边长（px）。默认 20，够按钮和行内使用。 */
    size?: number
    /**
     * 配色变体。图标默认跟主题走，但有些位置要的是语义状态色：
     *   warn    琥珀 —— 待专注 / 提醒
     *   danger  红   —— 高优先 / 异常
     *   done    绿   —— 已完成
     * 传了就走 <name>-<tint>-<skin>-<mode>.webp。
     */
    tint?: '' | 'warn' | 'danger' | 'done'
    /**
     * 实心变体。目前只有 star 有（已收藏 = 实心星）。
     * 走 <name>-fill-<skin>-<mode>.webp，由构建脚本填色生成。
     */
    fill?: boolean
    /** 水平翻转（chev 一个图标当左右两个用）。 */
    flip?: boolean
    /** 额外类名。 */
    cls?: string
  }>(),
  { size: 20, tint: '', fill: false, flip: false, cls: '' },
)

/**
 * 文件名规则：{name}[-{tint}|-fill]-{skin}-{mode}.webp
 *   skin ∈ moss | 550w    来自 core/store 的 skinClass
 *   mode ∈ dark | light   来自 core/store 的 themeClass
 *
 * 不用 CSS 变量拼路径：src 不是样式属性，变量插不进去。
 */
const src = computed(() => {
  const skin = skinClass.value === 'skin-550w' ? '550w' : 'moss'
  const mode = themeClass.value === 'is-light' ? 'light' : 'dark'
  const suffix = props.fill ? '-fill' : (props.tint ? `-${props.tint}` : '')
  return `/static/moss/icon/${props.name}${suffix}-${skin}-${mode}.webp`
})

const boxStyle = computed(() => ({
  width: `${String(props.size)}px`,
  height: `${String(props.size)}px`,
  transform: props.flip ? 'scaleX(-1)' : undefined,
}))
</script>

<template>
  <!--
    图标不铺满容器，是固定画布，所以用 aspectFit 保持比例。
    pointer-events: none：图标不该吃掉宿主的点击。
  -->
  <image
    class="mi"
    :class="props.cls"
    :src="src"
    mode="aspectFit"
    :style="boxStyle"
  />
</template>

<style lang="scss" scoped>
.mi {
  display: block;
  flex: none;
  pointer-events: none;
}
</style>
