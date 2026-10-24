<script setup lang="ts">
/**
 * 我的：设备域卡 + 同步状态 + 设置 + 关于 + 旧页入口。
 *
 * 这里的设置直接读写 core/store 的 state：
 * 皮肤与明暗是全局的，改完 WorkShell 的根 class 立刻变，
 * 同时用 markUserPreference 落盘，冷启动不会被系统主题改回去。
 */
import { computed } from 'vue'
import WorkShell from '@/components/WorkShell.vue'
import { DEVICES, deviceName, domainStats, switchDevice, useWork, work } from '@/core/workbench'
import { markUserPreference, state } from '@/core/store'
import { haptic } from '@/core/haptic'

const APP_VERSION = '0.1.0'
const PROTOCOL_LABEL = 'DSH Link · v1'

const { data } = useWork()

const currentDevice = computed(() => DEVICES.find((d) => d.id === work.deviceId) ?? DEVICES[0])
const stats = computed(() => domainStats(data.value))
const pending = computed(() => data.value.tasks.filter((t) => t.sync).length)
const conflicts = computed(() => data.value.tasks.filter((t) => t.conflict).length)
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

function cycleDevice(): void {
  const index = DEVICES.findIndex((d) => d.id === work.deviceId)
  const next = DEVICES[(index + 1) % DEVICES.length]
  if (next === undefined) return
  haptic('light')
  switchDevice(next.id)
  toast(`已切到「${next.name}」的数据域`)
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
      <!-- 设备域卡 -->
      <view class="device-card">
        <view class="dc-top">
          <view class="dc-av">
            <text class="dc-glyph">▣</text>
            <view class="dc-on" :class="{ off: !currentDevice.online }" />
          </view>
          <view class="dc-main">
            <view class="dc-name-row">
              <text class="dc-name">{{ currentDevice.name }}</text>
              <text class="badge" :class="currentDevice.online ? 'on' : 'mut'">
                {{ currentDevice.online ? '在线' : '离线' }}
              </text>
            </view>
            <text class="dc-sub">{{ currentDevice.sub }}</text>
          </view>
          <view class="btn dc-switch" @tap="cycleDevice">切换</view>
        </view>

        <view class="dc-stats">
          <view class="dc-stat">
            <text class="ds-v mono">{{ stats.total }}</text>
            <text class="ds-l">任务</text>
          </view>
          <view class="dc-stat">
            <text class="ds-v mono">{{ data.notes.length }}</text>
            <text class="ds-l">笔记</text>
          </view>
          <view class="dc-stat">
            <text class="ds-v mono">{{ data.focus.length }}</text>
            <text class="ds-l">专注</text>
          </view>
          <view class="dc-stat">
            <text class="ds-v mono">{{ data.news.length }}</text>
            <text class="ds-l">资讯</text>
          </view>
        </view>

        <view class="dc-foot">
          <text>本地数据 ≈ {{ dataKb }} KB · {{ recordCount }} 条记录</text>
          <text class="dc-dev mono">{{ work.deviceId }}</text>
        </view>
      </view>

      <!-- 同步状态（M2 占位，但仍展示真实的待推/冲突数） -->
      <view class="sync-row" @tap="placeholder('同步面板将在 M2 接入：待推 / 冲突 / 重试都在这里处理')">
        <view class="sync-icon"><text>⇅</text></view>
        <view class="sync-main">
          <view class="sync-t">
            <text>同步状态</text>
            <text class="sync-tag">M2 占位</text>
          </view>
          <text class="sync-d">
            待推 <text class="sync-n mono">{{ pending }}</text> 条 · 冲突
            <text class="sync-n mono">{{ conflicts }}</text> 条 · 上次同步 2 分钟前
          </text>
        </view>
        <text class="chev">›</text>
      </view>

      <!-- 外观 / 同步 / 数据 -->
      <view class="sect"><text>设置</text><text class="sect-n">即时生效</text></view>
      <view class="group">
        <view class="row">
          <view class="row-main">
            <text class="row-t">主题皮肤</text>
            <text class="row-d">MOSS 冷青绿 / 550W 待机红 · 同源令牌</text>
          </view>
          <view class="seg">
            <view class="seg-i" :class="{ on: state.skinMode === 'moss' }" @tap="pickSkin('moss')">
              <text>MOSS</text>
            </view>
            <view class="seg-i" :class="{ on: state.skinMode === '550w' }" @tap="pickSkin('550w')">
              <text>550W</text>
            </view>
          </view>
        </view>

        <view class="row">
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
          <text class="chev">›</text>
        </view>

        <view class="row tap" @tap="placeholder('回收站将在 M2 接入：软删保留 30 天，可随时恢复')">
          <view class="row-main">
            <text class="row-t">回收站</text>
            <text class="row-d">软删保留 30 天 · 删除不静默丢失</text>
          </view>
          <text class="row-val">12 项</text>
          <text class="chev">›</text>
        </view>
      </view>

      <!-- 旧页入口 -->
      <view class="sect"><text>DSH Link 旧页</text><text class="sect-n">设备 / 会话</text></view>
      <view class="group">
        <view class="row tap" @tap="go('/pages/index/index', '设备配对')">
          <view class="row-main">
            <text class="row-t">设备配对</text>
            <text class="row-d">连接一台电脑上的 DSH 工作台 · 局域网 / 中继</text>
          </view>
          <text class="chev">›</text>
        </view>
        <view class="row tap" @tap="go('/pages/sessions/sessions', '会话列表')">
          <view class="row-main">
            <text class="row-t">会话列表</text>
            <text class="row-d">查看各设备上正在跑 / 等待审批的会话</text>
          </view>
          <text class="chev">›</text>
        </view>
      </view>

      <!-- 关于 -->
      <view class="sect"><text>关于</text><text class="sect-n">M1 本地版</text></view>
      <view class="group">
        <view class="row">
          <view class="row-main">
            <text class="row-t">版本</text>
            <text class="row-d">MOSS AI App · 本地优先的多设备个人工作台</text>
          </view>
          <text class="row-val">v{{ APP_VERSION }} · M1</text>
        </view>
        <view class="row">
          <view class="row-main">
            <text class="row-t">协议版本</text>
            <text class="row-d">配对与会话通道 · 端到端加密 · 幂等重试</text>
          </view>
          <text class="row-val">{{ PROTOCOL_LABEL }}</text>
        </view>
      </view>

      <view class="foot-note">
        <text>
          M1 本地优先：任务 / 笔记 / 专注 / 资讯都离线可用；M2 接入 wb.* 同步后，
          与各台电脑上的 DSH 工作台双向同步，冲突默认保留两份。
        </text>
      </view>
    </view>
  </WorkShell>
</template>

<style lang="scss" scoped>
.mine-page { padding-top: 2px; }

.device-card {
  padding: 16px;
  border-radius: var(--r-lg);
  border: 1px solid var(--bd);
  background: linear-gradient(135deg, var(--s1) 58%, var(--acc-soft));
}
.dc-top { display: flex; align-items: center; gap: 12px; }
.dc-av {
  position: relative;
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  display: grid;
  place-items: center;
  border-radius: 15px;
  border: 1px solid var(--bd-strong);
  background: var(--acc-soft);
  color: var(--acc);
}
.dc-glyph { font-size: 20px; line-height: 1; }
.dc-on {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--ok);
  border: 2px solid var(--s1);
}
.dc-on.off { background: var(--t3); }
.dc-main { flex: 1; min-width: 0; }
.dc-name-row { display: flex; align-items: center; gap: 8px; }
.dc-name { font-size: 16px; font-weight: 700; color: var(--t1); }
.badge {
  flex: 0 0 auto;
  font-size: 9.5px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 999px;
}
.badge.on { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }
.badge.mut { color: var(--t3); background: var(--s3); }
.dc-sub {
  display: block;
  margin-top: 3px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 10px;
  color: var(--t3);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dc-switch {
  flex: 0 0 auto;
  width: auto;
  min-height: 32px;
  height: 32px;
  padding: 0 12px;
  font-size: 11.5px;
}

.dc-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 14px;
}
.dc-stat {
  padding: 9px 10px;
  border-radius: 10px;
  background: var(--s2);
  border: 1px solid var(--bd);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ds-v { font-size: 16px; font-weight: 600; color: var(--acc); }
.ds-l { font-size: 9px; letter-spacing: 0.08em; color: var(--t3); }
.dc-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 10px;
  color: var(--t3);
}
.dc-dev { margin-left: auto; }

.sync-row {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: var(--r-md);
  background: var(--s1);
  border: 1px solid var(--bd);
}
.sync-row:active { border-color: var(--bd-strong); }
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
.chev { flex: 0 0 auto; color: var(--t3); font-size: 16px; line-height: 1; }

.sect {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
  margin: 18px 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1.4px;
  color: var(--t3);
}
.sect-n {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 9.5px;
  letter-spacing: 0;
}
.group {
  border: 1px solid var(--bd);
  border-radius: var(--r-lg);
  background: var(--s1);
  overflow: hidden;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 56px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--bd);
}
.row:last-child { border-bottom: 0; }
.row.tap:active { background: var(--s2); }
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
  transition: background 160ms var(--ease-out), color 160ms var(--ease-out);
}
.seg-i.on {
  background: var(--acc);
  color: var(--acc-ink);
  font-weight: 600;
}

.foot-note {
  margin-top: 14px;
  padding: 14px;
  border-radius: var(--r-md);
  border: 1px dashed var(--bd);
  font-size: 10.5px;
  line-height: 1.85;
  color: var(--t3);
}

@media (min-width: 820px) {
  .device-card { padding: 18px; }
  .dc-stats { gap: 10px; }
  .row { padding: 12px 16px; }
}
</style>
