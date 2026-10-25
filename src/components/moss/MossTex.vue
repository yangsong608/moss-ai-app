<script setup lang="ts">
/**
 * 卡片背景纹理。
 *
 * ## 为什么用 <image> 而不是 CSS background-image
 *
 * uni-app 的 App 端（app-plus）对 CSS 里引本地静态资源有限制，
 * 而 <image> 的 src="/static/..." 是本工程已经验证过的路径
 * （见 MossBadge、me.vue 的品牌图，以及 MossIcon 的整套线稿图标）。
 * 统一走 <image>，
 * 避免出现"H5 有图、App 没图"的分裂。
 *
 * ## 为什么每类卡片一张图
 *
 * 早期版本只有 4 张通用图（hero/card/flat/amb），靠 CSS background-size
 * 拉伸套用到所有卡片。两个问题：
 *   1. **变形**。卡片宽高比从 114×44 到 358×300 不等，
 *      同一张图拉伸后菌丝会变成奇怪的比例。
 *   2. **图案错位**。列表卡文字在左上、大卡文字在左栏、
 *      任务卡四角都是控件 —— 图案该退到哪里，每个卡片不一样。
 *
 * 现在按 cardspecs 逐类出图：每类卡片有自己的比例、自己的图案落位、
 * 自己的文字安全区。清单见 tools/moss-render/card_specs.py。
 *
 * ## 强度由 CSS 控制，不由图片控制
 *
 * 图片里烘焙的是**图案遮罩**（哪里有纹、哪里干净），
 * 最终浓度由 --tex-*-op 控制。这样换肤时只换一次 opacity，
 * 不必为每个主题重新解码图片。
 *
 * 具体的浓度值不是拍脑袋定的，是 tools/moss-render/check-tex.py
 * 按真实图层模型算出来的：
 * 正文色 --t1 在文字区必须 ≥ 4.5:1，任何文字色相对无纹理基线的
 * 劣化 ≤ 35%。改浓度必须重跑那个脚本。
 */
import { computed } from 'vue'
import { skinClass, themeClass, state } from '@/core/store'

/**
 * 纹理种类。与 card_specs.py 的 key 一一对应。
 *
 *   hero    今天页大日期卡      → 天文刻度盘（同心环 + 星座连线）
 *   stat    今天页指标小卡      → 数据柱状 + 折线火花图
 *   quick   今天页快速记录条    → 笔尖 + 拖尾 + 星芒
 *   calpage 今天页台历卡        → 日历网格（部分格填充）
 *   flipcard 今天页任务卡       → 任务流节点 + 正交连线
 *   caldate 今天页日期块        → 月相圆盘 + 刻度
 *   menu    今天页底部弹层      → 抽屉三层错位板
 *   modal   今天页居中弹窗      → 碎裂警示三角
 *
 *   note       笔记卡              → 横排文本线 + 挂签
 *   reader     笔记页阅读面板      → 摊开的书
 *   placeholder笔记页空态占位      → 放大镜
 *   nbcol      笔记页笔记本侧栏    → 竖向书堆
 *
 *   news    资讯卡
 *   console 我的页控制台卡
 *   srow    会话行
 *   dev     首页设备卡
 *   agenda  日历页议程卡
 *
 *   timer   专注页计时卡      → 沙漏
 *   statbox 专注页统计小卡    → 径向仪表盘
 *   brand   关于页品牌卡      → MOSS 徽记
 *
 *   index 页：empty 空态 / ondev 本地域卡
 *   mine 页：local 本地域卡 / sync 同步行 / ovcard 总览卡
 *
 * 页面级环境层（pagehead / pagemid / pagetail）不走这里，
 * 由 MossPageBg 单独渲染 —— 它是整页构图，不是卡片内的纹理。
 *
 * 清单与 src/static/moss/tex/ 下的资产一一对应；
 * 加纹理名必须同时加资产，否则运行时会 404。
 */
type TexKey =
  | 'hero' | 'stat' | 'quick' | 'calpage' | 'flipcard' | 'caldate'
  | 'menu' | 'modal'
  | 'note' | 'reader' | 'placeholder' | 'nbcol'
  | 'news' | 'console'
  | 'srow' | 'dev'
  | 'agenda'
  | 'timer' | 'statbox' | 'brand'
  | 'empty' | 'ondev' | 'local' | 'sync' | 'ovcard'

const props = withDefaults(
  defineProps<{
    /**
     * 纹理种类。决定用哪一套图和哪个浓度令牌。
     *
     * 必填：每类卡片的图是按它的版式单独出的，
     * 落到别的卡片上会压字或错位。写错在这里是编译期错误，
     * 比运行时 404 好。
     */
    name: TexKey
    /** 额外类名（给宿主定位用）。 */
    cls?: string
    /**
     * 适配模式：
     *   'fill'（默认）—— scaleToFill 拉伸铺满。卡的实测尺寸与规格一致时无形变；
     *   'contain' —— aspectFit 等比放入。卡的尺寸会随版式/内容漂移时用，
     *               图形保持比例（两侧留透明边），绝不拉变形。
     *
     * 为什么需要它：place() 是把图形 contain 进锚矩形，但整张画布随后被
     * scaleToFill 拉到卡的实测尺寸——卡的比例和规格不一致时，
     * 锚区被各向异性缩放，里面的图形跟着变形（笔记卡在 iPad 竖屏
     * 636×136 的形态下被横向拉了一倍多）。
     *
     * full_bleed 类（满幅网格，见下方集合）必须保持 fill，否则网格会 letterbox。
     */
    fit?: 'fill' | 'contain'
  }>(),
  { cls: '', fit: 'fill' },
)

/**
 * 资源路径。
 *
 * 文件名规则：{name}-{skin}-{mode}.webp
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
  return `/static/moss/tex/${String(props.name)}-${skin}-${mode}.webp`
})

/**
 * 浓度令牌：跟着主题走，和 tokens.scss 里的值一一对应。
 *
 * 每类卡片有各自的浓度，因为它们的文字密度差太远：
 * 任务卡（flat）四��都是控件，纹理必须极淡；
 * 大日期卡（hero）有大片留白，可以给到接近满。
 */
const op = computed(() => `var(--tex-${String(props.name)}-op)`)
</script>

<template>
  <!--
    纹理层永远在最底，且不接收事件。
    pointer-events: none 是关键：不然它会吃掉卡片的点击，
    出现"点了没反应"——这类 bug 在真机上极难定位。
  -->
  <image
    class="tex"
    :class="props.cls"
    :src="src"
    :mode="props.fit === 'contain' ? 'aspectFit' : 'scaleToFill'"
    :style="{ opacity: op }"
  />
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
 * 低端机降级：纹理是 52 张 WebP 的解码开销，
 * state.lite 时直接不显示（docs/05 §6 的降级策略）。
 * 注意这里用的是父级的 is-lite —— .dsh 上有该类，
 * 但 scoped 样式要写成 :global(.dsh.is-lite) 才能命中。
 */
:global(.dsh.is-lite) .tex {
  display: none;
}
</style>
