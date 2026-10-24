<script setup lang="ts">
/**
 * 资讯屏：订阅 chips 筛选 + 卡片瀑布流（手机单列 / ≥700 两列）。
 *
 * 「立即检索」在 M1 只做真实的 loading → 结果提示：本地还没有抓取能力，
 * M2 由 DSH 侧的定时任务抓取后走 wb.* 同步落到这里。
 * 原文按钮也不假装能打开：有真实 URL 就复制链接，演示数据直接说明原因。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import WorkShell from '@/components/WorkShell.vue'
import { useWork } from '@/core/workbench'
import type { NewsItem } from '@/core/workbench'
import { haptic } from '@/core/haptic'
import { dispatchNewsFetch, liveAiHost } from '@/core/ai-dispatch'
import type { DispatchOutcome } from '@/core/ai-dispatch'

const ALL = '全部'

const { data } = useWork()

const filter = ref<string>(ALL)
const fetching = ref(false)
const lastFetchAt = ref(Date.now() - 12 * 60 * 1000)
/**
 * 立即检索（P2-2）的页面态：
 *   - feedHint：常驻状态行（派发中 / 新增几条 / 降级原因）；
 *   - feedWarn：降级或失败用警示色；
 *   - feedStop：离开页面时置 true，轮询最多再等一个 tick。
 */
const feedHint = ref('')
const feedWarn = ref(false)
let feedStop = false

const topics = computed(() => {
  const set = new Set<string>()
  for (const n of data.value.news) set.add(n.topic)
  return Array.from(set)
})
const visibleNews = computed<NewsItem[]>(() =>
  data.value.news.filter((n) => filter.value === ALL || n.topic === filter.value),
)
const lastFetchLabel = computed(() => {
  const minutes = Math.max(0, Math.floor((Date.now() - lastFetchAt.value) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  return `${Math.floor(minutes / 60)} 小时前`
})

function toast(title: string): void {
  uni.showToast({ title, icon: 'none', duration: 2000 })
}

function countOf(topic: string): number {
  return data.value.news.filter((n) => n.topic === topic).length
}

function setFilter(topic: string): void {
  if (filter.value === topic) return
  haptic('light')
  filter.value = topic
}

/**
 * 「立即检索」（P2-2）：派发给设备上的 DSH agent 检索当前订阅。
 *
 * 流程在 `ai-dispatch.ts`：先 syncNow() 推一轮 → workspace.list → session.create →
 * session.prompt（要求用 `workbench_news_publish` 写回，topicId 从宿主订阅表解析）→
 * 每 5s 同步一轮，最多 12 次，等新卡片出现。
 *
 * 注意：dsh-workbench 的增量同步不包含 news_items，所以每 tick 除了 syncNow()
 * 还会用 `wb.news.list` 拉一次快照合并（详见 ai-dispatch 注释）。
 */
const targetTopic = computed(() => {
  if (filter.value !== ALL && topics.value.includes(filter.value)) return filter.value
  return topics.value[0] ?? '资讯'
})

async function fetchNow(): Promise<void> {
  if (fetching.value) return
  haptic('light')
  const topic = targetTopic.value
  fetching.value = true
  feedWarn.value = false
  feedHint.value = `正在派发「${topic}」检索…`
  feedStop = false
  try {
    const host = await liveAiHost()
    const outcome = await dispatchNewsFetch(host, { topic }, { shouldStop: () => feedStop })
    applyFeedOutcome(outcome)
  } catch (error) {
    feedWarn.value = true
    feedHint.value = '派发失败：连接层不可用，已保留本机内容。'
    uni.showModal({
      title: '立即检索失败',
      content: `${feedHint.value}\n\n${error instanceof Error ? error.message : String(error)}`,
      showCancel: false,
      confirmText: '知道了',
    })
  } finally {
    fetching.value = false
  }
}

function applyFeedOutcome(outcome: DispatchOutcome): void {
  if (outcome.status === 'done' || outcome.status === 'timeout') lastFetchAt.value = Date.now()
  feedWarn.value = outcome.status !== 'done'
  feedHint.value = outcome.message
  if (outcome.status === 'done') {
    haptic('medium')
    toast(outcome.message)
    return
  }
  if (outcome.status === 'cancelled') return
  if (outcome.status === 'timeout') {
    uni.showToast({ title: '已在设备上执行，稍后自动同步', icon: 'none', duration: 2800 })
    return
  }
  const title = outcome.status === 'degraded'
    ? (outcome.code === 'no-workbench' ? '设备不支持资讯检索' : '需要连接设备')
    : '立即检索失败'
  uni.showModal({ title, content: outcome.message, showCancel: false, confirmText: '知道了' })
}

function openOriginal(item: NewsItem): void {
  haptic('light')
  if (item.url === '' || item.url === '#') {
    toast('演示条目暂无原文 · M2 接入后可在站内打开')
    return
  }
  uni.setClipboardData({
    data: item.url,
    success: () => toast('原文链接已复制'),
    fail: () => toast('复制失败，请稍后再试'),
  })
}

// 切设备域后，当前订阅可能在新域里不存在：回落到「全部」
watch(data, () => {
  if (filter.value === ALL) return
  if (!data.value.news.some((n) => n.topic === filter.value)) filter.value = ALL
})

onUnmounted(() => {
  // 离开页面后不再等设备回写：轮询下一个 tick 就退出（任务本身在设备上继续跑）
  feedStop = true
})
</script>

<template>
  <WorkShell active="news" title="资讯" :sub="`订阅 ${topics.length} 个源 · 本地 ${data.news.length} 条 · AI 摘要`">
    <view class="news-page">
      <view class="news-head">
        <view class="nh-copy">
          <text class="nh-title">AI 摘要 · 3 行内</text>
          <text class="nh-sub">上次检索 {{ lastFetchLabel }} · 离线可读 · 立即检索需连接设备</text>
          <text v-if="feedHint !== ''" class="nh-hint" :class="{ bad: feedWarn }">{{ feedHint }}</text>
        </view>
        <view class="btn primary fetch" :class="{ busy: fetching }" :aria-busy="fetching" @tap="fetchNow">
          <view v-if="fetching" class="fb-progress" aria-hidden="true"><view /><view /><view /></view>
          <text>{{ fetching ? '检索中…' : '立即检索' }}</text>
        </view>
      </view>

      <scroll-view scroll-x class="chips" :show-scrollbar="false">
        <view class="chip-row">
          <view class="chip fb-press" :class="{ on: filter === ALL }" @tap="setFilter(ALL)">
            <text>全部</text>
            <text class="chip-n mono">{{ data.news.length }}</text>
          </view>
          <view
            v-for="t in topics"
            :key="t"
            class="chip fb-press"
            :class="{ on: filter === t }"
            @tap="setFilter(t)"
          >
            <text>{{ t }}</text>
            <text class="chip-n mono">{{ countOf(t) }}</text>
          </view>
        </view>
      </scroll-view>

      <view class="sect">
        <text>{{ filter === ALL ? '全部订阅' : filter }}</text>
        <text class="sect-n">{{ visibleNews.length }} 条</text>
      </view>

      <view v-if="visibleNews.length > 0" :key="filter" class="news-grid">
        <view v-for="(n, index) in visibleNews" :key="n.id" class="news-card" :class="index < 8 ? `fb-stagger fb-i-${index}` : ''">
          <view class="nc-head">
            <text class="topic">{{ n.topic }}</text>
            <text class="nc-src">{{ n.source }}</text>
          </view>
          <text class="nc-title">{{ n.title }}</text>
          <text class="nc-sum">{{ n.summary }}</text>
          <view class="nc-foot">
            <text class="nc-when mono">{{ n.when }}</text>
            <view class="nc-go" @tap.stop="openOriginal(n)">
              <text>原文 ↗</text>
            </view>
          </view>
        </view>
      </view>

      <view v-else class="empty fb-empty">
        <text class="fb-empty-icon">▥</text>
        <text>这个订阅下暂时没有内容。</text>
        <text class="empty-hint">「立即检索」会把任务派给已连接的设备，回写后自动出现在这里。</text>
      </view>
    </view>
  </WorkShell>
</template>

<style lang="scss" scoped>
.news-page { padding-top: 2px; }

.news-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 2px 12px;
}
.nh-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nh-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--t2);
}
.nh-sub {
  font-size: 10px;
  line-height: 1.6;
  color: var(--t3);
}
/* 常驻状态行：派发中 / 新增条数 / 降级原因都写在这里 */
.nh-hint {
  font-size: 10px;
  line-height: 1.6;
  color: var(--t3);
}
.nh-hint.bad { color: var(--warn); }
.fetch {
  flex: 0 0 auto;
  width: auto;
  min-height: 40px;
  height: 40px;
  padding: 0 15px;
  font-size: 12.5px;
}
.fetch.busy {
  opacity: 0.6;
  pointer-events: none;
}

.chips { white-space: nowrap; padding-bottom: 2px; }
.chip-row { display: flex; gap: 8px; padding: 2px 1px 8px; }
.chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--s1);
  border: 1px solid var(--bd);
  color: var(--t2);
  font-size: 11.5px;
  font-weight: 600;
}
.chip:active { transform: scale(0.97); }
.chip.on {
  background: var(--acc-soft);
  border-color: var(--bd-strong);
  color: var(--acc);
}
.chip-n { font-size: 9.5px; color: var(--t3); }
.chip.on .chip-n { color: var(--acc); }

.sect {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
  margin: 14px 0 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1.4px;
  color: var(--t3);
}
.sect-n {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 10px;
  letter-spacing: 0;
}

/* CSS 多列 = 真瀑布流：卡片高度不同也能贴着上一张排 */
.news-grid {
  column-count: 1;
  column-gap: 12px;
}
.news-card {
  display: inline-block;
  width: 100%;
  vertical-align: top;
  break-inside: avoid;
  page-break-inside: avoid;
  -webkit-column-break-inside: avoid;
  margin: 0 0 12px;
  padding: 15px;
  border-radius: var(--r-md);
  background: var(--s1);
  border: 1px solid var(--bd);
  transition: transform 120ms var(--ease-out), opacity 120ms var(--ease-out);
}
.news-card:active { transform: scale(0.99); }
.nc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.topic {
  font-size: 9.5px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 999px;
  color: var(--acc);
  background: var(--acc-soft);
  border: 1px solid var(--bd);
}
.nc-src {
  margin-left: auto;
  font-size: 10px;
  color: var(--t3);
}
.nc-title {
  display: block;
  margin: 9px 0 6px;
  font-size: 14.5px;
  font-weight: 650;
  line-height: 1.55;
  letter-spacing: -0.1px;
  color: var(--t1);
}
.nc-sum {
  display: block;
  font-size: 12px;
  line-height: 1.85;
  color: var(--t2);
}
.nc-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 11px;
}
.nc-when { font-size: 10px; color: var(--t3); }
.nc-go {
  margin-left: auto;
  padding: 4px 8px;
  border-radius: 999px;
  color: var(--acc);
  background: var(--acc-soft);
  font-size: 10.5px;
  font-weight: 600;
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 26px 16px;
  border-radius: var(--r-md);
  border: 1px dashed var(--bd);
  font-size: 12px;
  color: var(--t2);
}
.empty-hint { font-size: 10.5px; line-height: 1.7; color: var(--t3); }

@media (min-width: 700px) {
  .news-grid { column-count: 2; }
}
</style>
