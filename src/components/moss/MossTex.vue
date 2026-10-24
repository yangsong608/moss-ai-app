<script setup lang="ts">
/**
 * 卡片背景纹理。
 *
 * ## 为什么用 <image> 而不是 CSS background-image
 *
 * uni-app 的 App 端（app-plus）对 CSS 里引本地静态资源有限制，
 * 而 <image> 的 src="/static/..." 是本工程已经验证过的路径
 * （见 MossBadge、me.vue 的 hero.webp）。统一走 <image>，
 * 避免出现"H5 有图、App 没图"的分裂。
 *
 * ## 为什么要分角色（card / hero / amb）
 *
 * 三类容器的排版密度差很远：
 *   · card  列表卡片，文字多，纹理必须退到角落
 *   · hero  主视觉卡，有大片留白，纹理可以铺得更开
 *   · amb   整页环境层，上面散布着各种文字，最克制
 * 同一张图套三种场景，结果一定是"要么太淡要么太吵"。
 *
 * ## 强度由 CSS 控制，不由图片控制
 *
 * 图片里烘焙的是**图案遮罩**（哪里有纹、哪里干净），
 * 最终浓度由 --tex-*-op 控制。这样换肤时只换一次 opacity，
 * 不必为每个主题重新解码图片；同一张图也能被不同卡片复用。
 *
 * 具体的浓度值不是拍脑袋定的，是 tools/moss-render/check-tex.py
 * 按「玻璃层盖在纹理上」的真实图层模型算出来的：
 * 正文色 --t1 在文字区必须 ≥ 4.5:1，任何文字色相对无纹理基线的
 * 劣化 ≤ 35%。改浓度必须重跑那个脚本。
 */
import { computed } from 'vue'
import { skinClass, themeClass, state } from '@/core/store'

type Role = 'card' | 'hero' | 'amb'

const props = withDefaults(
  defineProps<{
    /** 纹理角色。决定用哪一套图。 */
    role?: Role
    /** 额外类名（给宿主定位用）。 */
    cls?: string
  }>(),
  { role: 'card', cls: '' },
)

/**
 * 资源路径。
 *
 * 文件名规则：{role}-{skin}-{mode}.webp
 *   skin ∈ moss | 550w    来自 core/store 的 skinClass
 *   mode ∈ dark | light   来自 core/store 的 themeClass
 *
 * 这里不用 CSS 变量拼路径，而是直接算：CSS 变量在 <image> 的 src 上
 * 不可用（src 不是样式属性），所以路径必须由 JS 给出。
 * 样式那边只负责 opacity 与定位。
 */
const src = computed(() => {
  const skin = skinClass.value === 'skin-550w' ? '550w' : 'moss'
  const mode = themeClass.value === 'is-light' ? 'light' : 'dark'
  return `/static/moss/tex/${String(props.role)}-${skin}-${mode}.webp`
})

/** 浓度令牌：跟着主题走，和 tokens.scss 里的值一一对应。 */
const op = computed(() => {
  switch (props.role) {
    case 'hero': return 'var(--tex-hero-op)'
    case 'amb': return 'var(--tex-amb-op)'
    default: return 'var(--tex-card-op)'
  }
})
</script>

<template>
  <!--
    纹理层永远在最底，且不接收事件。
    pointer-events: none 是关键：不然它会吃掉卡片的点击，
    出现"点了没反应"——这类 bug 在真机上极难定位。
  -->
  <image class="tex" :class="props.cls" :src="src" mode="scaleToFill" :style="{ opacity: op }" />
</template>

<style lang="scss" scoped>
.tex {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
}

/*
 * 低端机降级：纹理是 12 张 WebP 的解码开销，
 * state.lite 时直接不显示（docs/05 §6 的降级策略）。
 * 注意这里用的是父级的 is-lite —— .dsh 上有该类，
 * 但 scoped 样式要写成 :global(.dsh.is-lite) 才能命中。
 */
:global(.dsh.is-lite) .tex {
  display: none;
}
</style>
