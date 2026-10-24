<script setup lang="ts">
/**
 * 整页环境背景（页面级，不是卡片级）。
 *
 * ## 和 MossTex 的分工
 *
 *   MossTex     贴在**某一张卡片内部**，靠 anchor 精确避开那张卡的文字。
 *              改卡片布局就要重新出图。
 *   MossPageBg  铺在**页面根**上，三层固定构图：头 / 中 / 尾。
 *              不跟着任何卡片走，所以页面怎么改布局都不用重新出图。
 *
 * ## 为什么能挂在内容下面还不改每个页面
 *
 * `.dsh`（每个页面的根）在 moss.scss 里已经是
 * `position: relative; overflow: hidden; z-index: 0` —— 有定位、会裁切、
 * 又是层叠上下文。所以这里只要 `z-index: -1`，就正好落在
 *「根的背景之上、所有内容之下」，不需要给任何页面加 z-index。
 *
 * 反过来，如果给 .pb 用 `z-index: 0`，它会盖在文字上面
 * （定位元素 z-index>=0 的绘制顺序本来就排在普通流内容之后）——
 * 这个坑踩过，别改回去。
 *
 * ## 三层构图（按需求：头尾有像样的图，中间极简）
 *
 *   pagehead  头顶：天球仪边缘的三段同心弧 + 弧上两颗节点 + 四角星
 *   pagemid   中部：一条通栏细线 + 三个节点（极简，它整条压在内容区上）
 *   pagetail  底部：地平线长弧 + 弧下四根短刻度 + 右端节点
 *
 * ## 手机 / 平板
 *
 * 三层都是 `width: Npx; max-width: 100%`：手机上退到整宽，
 * 平板上收敛到固定宽度居中，不会因为屏幕宽而被拉成一条胖线。
 * 尾部在手机上要避开底部导航（高约 54px，且 94% 不透明，
 * 压在底下等于白画）——断点 760px 与 WorkShell 的导航断点一致。
 */
import { computed } from 'vue'
import { skinClass, themeClass } from '@/core/store'

const props = withDefaults(
  defineProps<{
    /**
     * 宿主的底部导航形态。
     *   'shell' —— WorkShell / PageShell：手机底部导航、平板左侧竖栏，
     *              尾部图形需要坐在底部导航上方。
     *   'none'  —— 没有底部导航的页面（index / chat / note-edit）。
     */
    nav?: 'shell' | 'none'
  }>(),
  { nav: 'shell' },
)

/**
 * 资源路径。文件名规则同 MossTex：{name}-{skin}-{mode}.webp
 * 皮肤与明暗都从 store 取，所以换主题时 JS 侧换 src，
 * CSS 侧只换 opacity —— 一张图四个主题共用，不重复解码。
 */
const skin = computed(() => (skinClass.value === 'skin-550w' ? '550w' : 'moss'))
const mode = computed(() => (themeClass.value === 'is-light' ? 'light' : 'dark'))

const head = computed(() => `/static/moss/tex/pagehead-${skin.value}-${mode.value}.webp`)
const mid = computed(() => `/static/moss/tex/pagemid-${skin.value}-${mode.value}.webp`)
const tail = computed(() => `/static/moss/tex/pagetail-${skin.value}-${mode.value}.webp`)
</script>

<template>
  <view class="pb" :class="{ 'pb-shell': props.nav === 'shell' }">
    <image class="pb-l pb-head" :src="head" mode="widthFix" />
    <image class="pb-l pb-mid" :src="mid" mode="widthFix" />
    <image class="pb-l pb-tail" :src="tail" mode="widthFix" />
  </view>
</template>

<style lang="scss" scoped>
.pb {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: -1;
  pointer-events: none;
  overflow: hidden;
}

.pb-l {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}

/* 头顶天穹弧。图形本身是 1.66:1 的穹顶，460px 宽时高约 277px，
   正好罩住页头又不往内容区压太深。 */
.pb-head {
  top: 0;
  width: 460px;
  max-width: 100%;
  opacity: var(--tex-pagehead-op);
}

/* 中部细线。故意压得很低——它整条横在内容区上，只是"那里有条链路"，
   不是给人盯着看的。 */
.pb-mid {
  top: 50%;
  transform: translate(-50%, -50%);
  width: 760px;
  max-width: 100%;
  opacity: var(--tex-pagemid-op);
}

/* 底部地平线。 */
.pb-tail {
  bottom: 0;
  width: 460px;
  max-width: 100%;
  opacity: var(--tex-pagetail-op);
}

/*
 * 手机：底部导航约 54px 高，尾部图形坐在它上面。
 * 断点取 760px，和 WorkShell 的导航断点（min-width:760px and min-height:520px）
 * 保持一致 —— 手机横屏 844×390 高度不够 520，仍走底部导航，也要让位。
 */
@media (max-width: 759px) {
  .pb-shell .pb-tail {
    bottom: 56px;
  }
}

/* 低端机降级：三层常驻图也是解码开销，和 MossTex 一个策略 */
:global(.dsh.is-lite) .pb {
  display: none;
}
</style>
