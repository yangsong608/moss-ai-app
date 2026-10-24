<script setup lang="ts">
/**
 * 入口页：设备与配对。
 *
 * 设计决定：**这一页没有底部 Tab**。
 * 首页不是"四个目的地之一"，而是进 App 的那道门：选一台电脑进去，
 * 或者不连电脑直接进本地域。底部导航会把它降级成并列的一项，
 * 也让第一次打开的人先看到"会话/我的"这些还没有内容的地方。
 * 所以这里独立成全屏三段式：品牌区 → 设备卡列表 → 底部悬浮主按钮。
 *
 * 启动动画（MossBoot）只播一次，逻辑沿用原实现：标记放 storage，
 * 冷启动时由 App.vue 清掉。
 */
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import MossBoot from '@/components/moss/MossBoot.vue'
import MossBadge from '@/components/moss/MossBadge.vue'
import MossDot from '@/components/moss/MossDot.vue'
import MossVeil from '@/components/moss/MossVeil.vue'
import MossSheet, { type SheetItem } from '@/components/MossSheet.vue'
import { state, skinClass, themeClass, liteClass, type DeviceCard } from '@/core/store'
import { haptic } from '@/core/haptic'
import { connectDevice, disconnectManual, refreshAll, currentLink } from '@/core/link'
import { decodePairUri } from '@dsh-link/protocol'
import { LOCAL_DOMAIN_ID, switchDevice, work } from '@/core/workbench'

/**
 * 启动动画：一次进程生命周期内只播一次。
 *
 * 标记放 storage 而不是模块变量：reLaunch 会重建页面，模块变量在某些平台上
 * 会随页面一起重置，表现就是"每回到首页就重播一遍 4.3 秒开机"。
 */
let bootPlayed = (() => {
  try { return uni.getStorageSync('dsh-link/booted') === '1' } catch { return false }
})()
const booting = ref(!bootPlayed)

/** 有设备在干活时品牌角标亮起（"在干活"而不是"在线"）。 */
const anyWorking = computed(() => state.devices.some((d) => (d.runningCount ?? 0) > 0))
const refreshing = ref(false)

const onlineCount = computed(() => state.devices.filter((d) => d.conn === 'online').length)
/** 待确认配对：连得上但还没认证的设备，单独成块，不和普通设备混在一起。 */
const needAuth = computed(() => state.devices.filter((d) => d.conn === 'needs-auth'))

/**
 * 主列表里的设备。
 *
 * 剔除已进入「待确认配对」的机器：同一台电脑上下各出现一次，用户会以为
 * 自己配了两台，小屏上还白白吃掉半屏滚动。谁需要你，就只在该出现的地方出现。
 */
const pairedDevices = computed(() => state.devices.filter((d) => d.conn !== 'needs-auth'))

const rootClass = computed(() => ['dsh', 'idx', skinClass.value, themeClass.value, liteClass.value])

/** 当前数据域是不是「本地域」——入口卡据此显示"当前"。 */
const isLocal = computed(() => work.deviceId === LOCAL_DOMAIN_ID)

/* ── 主题 ─────────────────────────────────────────────────────────── */

/**
 * 主题切换。
 *
 * 这一页没有工作台的顶栏，但"换深/浅色"是全局偏好，
 * 入口页是最该给它的地方——否则用户得先进工作台才能调。
 */
function toggleTheme(): void {
  state.light = !state.light
  haptic('light')
}

/* ── 弹层控制器（与设备管理菜单共用一套交互语言） ───────────────────── */

interface SheetState {
  visible: boolean
  kind: 'menu' | 'confirm' | 'prompt' | 'info'
  title?: string
  items?: SheetItem[]
  message?: string
  value?: string
  placeholder?: string
  confirmText?: string
  onSelect?: (index: number) => void
  onConfirm?: (text: string) => void
}
const sheet = ref<SheetState>({ visible: false, kind: 'menu' })

function openSheet(opts: Omit<SheetState, 'visible'>): void {
  sheet.value = { visible: true, ...opts }
}

function onSheetSelect(index: number): void { sheet.value.onSelect?.(index) }
function onSheetConfirm(text: string): void { sheet.value.onConfirm?.(text) }

/* ── 设备状态 ─────────────────────────────────────────────────────── */

function statusOf(d: DeviceCard): 'online' | 'connecting' | 'offline' | 'needs-auth' | 'locked' {
  // 非当前连接的设备没有本地连接状态，用宿主下发的 online 判断
  if (d.conn !== 'online' && d.online === false) return 'offline'
  if (d.conn === 'offline') return 'offline'
  if (d.conn === 'needs-auth') return 'needs-auth'
  if (d.conn === 'connecting') return 'connecting'
  if (d.lock?.locked) return 'locked'
  return 'online'
}

function statusText(s: ReturnType<typeof statusOf>): string {
  switch (s) {
    case 'online': return '在线'
    case 'connecting': return '连接中'
    case 'offline': return '离线'
    case 'needs-auth': return '待确认'
    case 'locked': return '已锁定'
    default: return '未知'
  }
}

function isActive(d: DeviceCard): boolean {
  return d.deviceId === state.activeId
}

/** 数据域 id 跟宿主走：同一台电脑换手机仍是同一份数据。 */
function domainIdOf(d: DeviceCard): string {
  return d.host?.hostId ?? d.deviceId
}

function platformLabel(p: string): string {
  switch (p) {
    case 'darwin': return 'macOS'
    case 'win32': return 'Windows'
    case 'linux': return 'Linux'
    case 'ios': return 'iOS'
    case 'android': return 'Android'
    default: return p
  }
}

function endpointLabel(kind: string): string {
  switch (kind) {
    case 'lan': return '局域网'
    case 'relay': return '中继'
    case 'tailscale': return 'Tailscale'
    default: return '自定义'
  }
}

/** 相对时间：刚才 / N 分钟前 / N 小时前 / N 天前。 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (!Number.isFinite(diff) || diff < 0) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/**
 * 设备卡第二行：这是什么机器、怎么连的、连到哪。
 *
 * 地址必须露出来：同一台 Mac 有两个网卡时，IP 是唯一能区分"我连的是谁"的
 * 东西；只写"局域网"等于没说。离线时补一句"上次在线 N 小时前"，
 * 而不是写死一个假时间。
 */
function hostLine(d: DeviceCard): string {
  const bits: string[] = []
  if (d.platform) bits.push(platformLabel(d.platform))
  if (d.endpoint?.kind) bits.push(endpointLabel(d.endpoint.kind))
  const addr = d.endpoint?.url ?? ''
  const host = addr.replace(/^wss?:\/\//, '').replace(/\/.*$/, '')
  if (host.length > 0) bits.push(host)
  if (d.conn === 'offline' && typeof d.lastSeen === 'number') {
    bits.push(`上次在线 ${relativeTime(d.lastSeen)}`)
  }
  return bits.join(' · ')
}

/** 延迟：只给真测到的数字，没测到就是「—」，不编。 */
function latencyText(d: DeviceCard): string {
  if (typeof d.latencyMs === 'number' && d.conn !== 'offline') return `${d.latencyMs}ms`
  return '—'
}

function latencyTone(d: DeviceCard): string {
  if (typeof d.latencyMs !== 'number' || d.conn === 'offline') return 'dim'
  return d.latencyMs <= 80 ? 'ok' : d.latencyMs <= 200 ? 'mid' : 'slow'
}

/**
 * 会话统计。
 *
 * 当前连接的那台设备用本地已知的会话数（刚拉过 session.list）；
 * 其它设备只能用宿主下发的统计，没有就不显示数字——
 * 编一个数字比留空更糟。
 */
interface SessionStat {
  total: number | undefined
  running: number
  waiting: number
}

function sessionStats(d: DeviceCard): SessionStat {
  const active = isActive(d)
  const sessions = active ? state.sessions : []
  const total = d.sessionCount ?? (active ? sessions.length : undefined)
  const running = d.runningCount ?? (active ? sessions.filter((x) => x.status === 'running').length : 0)
  const waiting = active
    ? sessions.filter((x) => x.status === 'waiting-approval' || x.status === 'waiting-input').length
    : 0
  return { total, running, waiting }
}

/** 会话数：未知时用「—」，与延迟的缺省表达保持一致。 */
function totalText(d: DeviceCard): string {
  const total = sessionStats(d).total
  return total === undefined ? '—' : String(total)
}

/**
 * 这台设备的数据量。
 *
 * 数据域是按需加载的：已经进过那台设备的工作台，就能读到它的
 * 任务/笔记/专注条目数；没进过就不显示这一格，而不是写个 0——
 * "0 项数据"会被理解成"里面没东西"，实际只是"还没读过"。
 */
function dataVolume(d: DeviceCard): number | undefined {
  const dom = work.domains[domainIdOf(d)]
  if (dom === undefined) return undefined
  return dom.tasks.length + dom.notes.length + dom.focus.length
}

/* ── 费用与峰谷（宿主装了 dsh-cost-meter 才有） ───────────────────── */

interface CostInfo {
  available: boolean
  session?: unknown
  peak?: { peak: boolean; weekend?: boolean; msUntilSwitch: number; next: 'peak' | 'offPeak' } | null
}
const cost = ref<CostInfo | undefined>(undefined)

/**
 * 会话费用文本。
 *
 * 真实结构（实测）：
 *   { own: { cost, costCny, apiCost, calls, input, output }, subagents, subagentCount, found }
 * 优先显示人民币（用户在国内），没有 CNY 字段时回退美元。
 * 金额很小时保留 3 位小数：一次对话可能只花几分钱。
 */
function costText(): string {
  const c = cost.value
  if (c?.available !== true) return ''
  const session = c.session as
    | { own?: { cost?: number; costCny?: number }; found?: boolean }
    | null
    | undefined
  const own = session?.own
  if (own === undefined) return ''

  const cny = typeof own.costCny === 'number' ? own.costCny : undefined
  const usd = typeof own.cost === 'number' ? own.cost : undefined
  if (cny !== undefined) return `¥${cny.toFixed(cny < 1 ? 3 : 2)}`
  if (usd !== undefined) return `$${usd.toFixed(usd < 1 ? 3 : 2)}`
  return ''
}

/** 峰谷提醒：只给"还有多久切换"，不说"省多少钱"——金额口径不归我们解释。 */
function peakText(): string {
  const p = cost.value?.peak
  if (p === null || p === undefined) return ''
  const mins = Math.round(p.msUntilSwitch / 60_000)
  const when = mins >= 90 ? `${Math.round(mins / 60)} 小时` : `${String(mins)} 分钟`
  if (p.weekend === true) return '周末谷价'
  return p.peak ? `峰时计价 · ${when}后转谷时` : `谷时计价 · ${when}后转峰时`
}

function peakTone(): 'peak' | 'valley' | '' {
  const p = cost.value?.peak
  if (p === null || p === undefined) return ''
  return p.peak ? 'peak' : 'valley'
}

async function loadCost(): Promise<void> {
  const link = currentLink()
  if (link === undefined) { cost.value = undefined; return }
  // 用最近一次会话的费用：设备卡是"这台机器上正在发生的事"的入口
  const sessionId = state.sessions[0]?.id ?? ''
  try {
    cost.value = await link.call<CostInfo>('cost.summary', sessionId.length > 0 ? { sessionId } : {})
  } catch {
    cost.value = undefined
  }
}

/* ── 进入设备 / 本地域 ────────────────────────────────────────────── */

function onBootDone(): void {
  bootPlayed = true
  booting.value = false
  try { uni.setStorageSync('dsh-link/booted', '1') } catch { /* 存不下就退化成每次播 */ }
}

/**
 * 选择设备 → 进入工作台。
 *
 * 先激活设备并映射数据域，再 reLaunch 到今天：页面栈里不留设备页，
 * 避免返回时"退不出去"。
 */
function open(d: DeviceCard): void {
  haptic('light')
  state.activeId = d.deviceId
  if (d.lock?.locked) {
    state.lockDialogFor = d.deviceId
    return
  }
  switchDevice(domainIdOf(d))
  uni.reLaunch({ url: '/pages/today/today' })
}

/**
 * 本地域入口：不连电脑也能用任务/日历/专注/笔记。
 *
 * 会话与 AI 必须连电脑，所以本地域里它们不存在——这一点写在卡片说明里，
 * 而不是等用户点进去发现"会话是空的"。
 */
function goLocal(): void {
  haptic('medium')
  switchDevice(LOCAL_DOMAIN_ID)
  uni.reLaunch({ url: '/pages/today/today' })
}

function requestUnlock(): void {
  haptic('medium')
  state.lockDialogFor = ''
  uni.showToast({ title: '已向电脑发送解锁请求', icon: 'none' })
}

function dismiss(): void {
  state.lockDialogFor = ''
}

async function refresh(): Promise<void> {
  refreshing.value = true
  haptic('light')
  // TODO(M1): 换成 Link.call('device.list')
  await new Promise((r) => setTimeout(r, 600))
  refreshing.value = false
}

/* ── 配对面板 ─────────────────────────────────────────────────────── */

/**
 * 配对流程是「电脑出码 → 手机输码」，不是反的：
 *   1. 电脑上打开 MOSS Link → 生成配对码（这个动作本身就是"本人在场"）
 *   2. 手机扫码或输入这 6 位码
 *   3. 拿到 bearer token，之后靠它认证
 * 逻辑与旧版一致，只换了外观与入口位置（底部主按钮）。
 */
const pairOpen = ref(false)
const pairError = ref('')
const pairBusy = ref(false)
const pairInput = ref('')
/** 输错时给输入框一个短抖动，见 finishPair */
const pairShake = ref(false)
const pairAddress = ref('')

/** 还没配对过、也没有缓存地址时需要用户手填一次。 */
const needsAddress = computed(() => {
  const device = state.devices.find((d) => d.deviceId === state.activeId) ?? state.devices[0]
  return device?.endpoint?.url === undefined
})

function addDevice(): void {
  haptic('medium')
  pairOpen.value = true
  pairError.value = ''
  pairInput.value = ''
}

/** 从「待确认配对」卡进来：地址已知，预填进配对面板。 */
function openPairFor(d: DeviceCard): void {
  haptic('medium')
  pairAddress.value = d.endpoint?.url ?? ''
  pairInput.value = ''
  pairError.value = ''
  pairOpen.value = true
}

/** 扫码：二维码里一次拿到「地址 + 码」，用户不用手抄 ws:// 地址。 */
function scanToPair(): void {
  haptic('light')
  uni.scanCode({
    onlyFromCamera: false,
    scanType: ['qrCode'],
    success: (res) => {
      const raw = typeof res.result === 'string' ? res.result : ''
      const parsed = decodePairUri(raw)
      if (!parsed.ok) {
        // 失败时把**原始内容**也显示出来（截断）：扫码 SDK 可能改写内容，
        // "看到的是什么"比"我判断它不对"更有用。
        const preview = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw
        pairError.value =
          (parsed.reason === 'not-pair-uri'
            ? '这不是 MOSS Link 的配对码'
            : '配对码格式不对，请让电脑重新生成') +
          (preview.length > 0 ? `（扫到：${preview}）` : '（扫到空内容）')
        return
      }
      pairAddress.value = parsed.wsUrl
      pairInput.value = parsed.payload.code
      pairError.value = ''
      void finishPair()
    },
    fail: () => {
      // 用户取消扫码不是错误，不弹提示
    },
  })
}

function closePair(): void {
  pairOpen.value = false
  pairBusy.value = false
  pairError.value = ''
}

async function finishPair(): Promise<void> {
  if (pairBusy.value) return
  const code = pairInput.value.trim()
  if (!/^\d{6}$/.test(code)) {
    pairError.value = '请输入电脑上显示的 6 位数字'
    // 输错时抖一下输入框：比只出一行红字更容易被注意到
    pairShake.value = false
    requestAnimationFrame(() => { pairShake.value = true })
    return
  }

  /**
   * 决定连哪台机器：**本次明确提供的地址优先**。
   *
   * 旧实现是「优先当前设备，没有才用输入框地址」，于是已有设备时
   * 扫码给的地址被完全忽略，用旧地址一直配对到超时。
   */
  const typedUrl = pairAddress.value.trim()
  const hasTypedUrl = /^wss?:\/\//.test(typedUrl)

  let device = state.devices.find((d) => d.deviceId === state.activeId) ?? state.devices[0]

  if (hasTypedUrl) {
    const existing = state.devices.find((d) => d.endpoint?.url === typedUrl)
    if (existing !== undefined) {
      // 地址已经配对过：直接复用，避免建出重复设备卡
      device = existing
      state.activeId = existing.deviceId
    } else {
      // 新地址：建一条临时设备（配对成功后会从 device.list 拿到真实 id）
      device = {
        deviceId: `tmp_${Date.now()}`,
        name: '未命名电脑',
        platform: 'desktop',
        role: 'operator',
        createdAt: Date.now(),
        lastSeen: Date.now(),
        conn: 'connecting',
        endpoint: { url: typedUrl, kind: typedUrl.startsWith('wss:') ? 'relay' : 'lan' },
      }
      state.devices = [...state.devices, device]
      state.activeId = device.deviceId
    }
  } else if (device === undefined) {
    pairError.value = '请填写电脑地址，例如 ws://192.168.1.23:7443/dshlink'
    return
  }

  const link = connectDevice(device)
  if (link === undefined) {
    pairError.value = '无法连接电脑，请确认地址正确且在同一局域网'
    return
  }

  pairBusy.value = true
  pairError.value = ''
  try {
    const info = uni.getSystemInfoSync()
    const result = await link.call<{ deviceId: string; label: string; token: string }>('pair.finish', {
      code,
      label: `${info.platform ?? 'mobile'} 上的 DSH Link`,
      platform: info.platform ?? 'unknown',
    })
    // 令牌是 bearer 凭证：只存 token，不存密码——密码永不出现在移动端。
    try {
      uni.setStorageSync(`dsh-link/token/${result.deviceId}`, result.token)
    } catch {
      // 存储失败不影响本次会话，只是下次要重新配对
    }
    await refreshAll()
    haptic('medium')
    closePair()
    uni.showToast({ title: '配对成功', icon: 'none' })
  } catch (error) {
    pairError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pairBusy.value = false
  }
}

/* ── 设备管理（长按 / 卡片右上「⋯」） ─────────────────────────────── */

/**
 * 管理是低频操作，不放在卡片正面上——卡片正面是"点进去"。
 * 长按与右上角「⋯」都能打开，兼顾老用户和没发现长按的人。
 */
function deviceMenu(d: DeviceCard): void {
  haptic('medium')
  openSheet({
    kind: 'menu',
    title: d.name,
    items: [
      { label: '重命名', hint: '改的是本机显示名，不影响电脑' },
      { label: '查看详情', hint: '设备 ID / 地址 / 状态' },
      { label: '重新连接', hint: '断线后手动重连（不动配对关系）' },
      { label: '修改地址', hint: '电脑换了 IP 或端口时用这个' },
      { label: '断开连接', hint: '只是断线，配对关系保留' },
      { label: '移除设备', hint: '需要重新配对才能再连', danger: true },
    ],
    onSelect: (i) => {
      if (i === 0) void renameDevice(d)
      else if (i === 1) showDeviceDetail(d)
      else if (i === 2) reconnectDevice(d)
      else if (i === 3) editEndpoint(d)
      else if (i === 4) disconnectManualDevice(d)
      else if (i === 5) void removeDevice(d)
    },
  })
}

async function renameDevice(d: DeviceCard): Promise<void> {
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  openSheet({
    kind: 'prompt',
    title: '重命名设备',
    message: '只改本机显示名，电脑上不受影响。',
    value: d.name,
    placeholder: '给这台电脑起个名字',
    confirmText: '保存',
    onConfirm: (text) => {
      const label = text.trim()
      if (label.length === 0) return
      void link.call('device.rename', { deviceId: d.deviceId, label }).then(() => {
        const idx = state.devices.findIndex((x) => x.deviceId === d.deviceId)
        if (idx >= 0) {
          const cur = state.devices[idx]
          if (cur !== undefined) state.devices[idx] = { ...cur, name: label }
        }
        uni.showToast({ title: '已重命名', icon: 'none' })
      }).catch((e: unknown) => {
        uni.showToast({ title: e instanceof Error ? e.message.slice(0, 16) : '失败', icon: 'none' })
      })
    },
  })
}

function showDeviceDetail(d: DeviceCard): void {
  const lines = [
    `名称：${d.name}`,
    `平台：${platformLabel(d.platform)}`,
    `角色：${d.role}`,
    `设备 ID：${d.deviceId}`,
    `连接地址：${d.endpoint?.url ?? '（未知）'}`,
    `状态：${statusText(statusOf(d))}`,
    d.lastSeen ? `最近活跃：${relativeTime(d.lastSeen)}` : '',
  ].filter((x) => x.length > 0)
  openSheet({ kind: 'info', title: '设备详情', message: lines.join('\n') })
}

/**
 * 修改连接地址。
 *
 * 电脑换了网络/端口后，App 里存的还是旧地址，表现是"连接超时"，
 * 而用户不知道要改哪里。这个入口就是把唯一需要改的字段露出来。
 */
function editEndpoint(d: DeviceCard): void {
  const current = d.endpoint?.url ?? ''
  openSheet({
    kind: 'prompt',
    title: '修改连接地址',
    message: '在电脑的 MOSS Link 设置里能看到当前地址。格式 ws://IP:端口/dshlink。',
    value: current,
    placeholder: 'ws://192.168.1.10:7443/dshlink',
    confirmText: '保存并重连',
    onConfirm: (text) => {
      const url = text.trim()
      if (!/^wss?:\/\/[^\s]+$/.test(url)) {
        uni.showToast({ title: '需以 ws:// 或 wss:// 开头', icon: 'none' })
        return
      }
      const idx = state.devices.findIndex((x) => x.deviceId === d.deviceId)
      if (idx >= 0) {
        const cur = state.devices[idx]
        if (cur !== undefined) state.devices[idx] = { ...cur, endpoint: { url, kind: 'lan' }, conn: 'connecting' }
      }
      haptic('medium')
      const next = state.devices[idx]
      if (next !== undefined) connectDevice(next)
    },
  })
}

/**
 * 手动重连：连接对象对同一地址是幂等的，所以"再点一次"不会真的重建 socket；
 * 断线后想强制重来必须先关掉旧连接（走 manual 版，避免被自动重连抢先）。
 */
function reconnectDevice(d: DeviceCard): void {
  haptic('medium')
  disconnectManual()
  const idx = state.devices.findIndex((x) => x.deviceId === d.deviceId)
  if (idx >= 0) {
    const cur = state.devices[idx]
    if (cur !== undefined) state.devices[idx] = { ...cur, conn: 'connecting' }
  }
  const next = state.devices[idx]
  if (next !== undefined) connectDevice(next)
}

function disconnectManualDevice(d: DeviceCard): void {
  disconnectManual()
  const idx = state.devices.findIndex((x) => x.deviceId === d.deviceId)
  if (idx >= 0) {
    const cur = state.devices[idx]
    if (cur !== undefined) state.devices[idx] = { ...cur, conn: 'offline' }
  }
  haptic('light')
  uni.showToast({ title: '已断开', icon: 'none' })
}

async function removeDevice(d: DeviceCard): Promise<void> {
  openSheet({
    kind: 'confirm',
    title: `移除「${d.name}」`,
    message: '这台设备需要重新配对才能再连接。已有会话不受影响。',
    confirmText: '移除',
    onConfirm: () => {
      const link = currentLink()
      void (async () => {
        if (link !== undefined) {
          try { await link.call('device.revoke', { deviceId: d.deviceId }) } catch { /* 撤销失败也允许本地移除 */ }
        }
        state.devices = state.devices.filter((x) => x.deviceId !== d.deviceId)
        // 会话跟着设备一起消失：会话的归属是设备，不是全局
        state.sessions = state.sessions.filter((x) => (x.hostId ?? state.activeId) !== d.deviceId)
        if (state.activeId === d.deviceId) state.activeId = state.devices[0]?.deviceId ?? ''
        haptic('heavy')
        uni.showToast({ title: '已移除', icon: 'none' })
      })()
    },
  })
}

onLoad(() => {
  // 首页只做一件事：确保有一条连接，然后拉真实设备表。
  // 没有设备时不造假数据——显示空态与两个真入口。
  const device = state.devices.find((d) => d.deviceId === state.activeId) ?? state.devices[0]
  if (device !== undefined) {
    state.activeId = device.deviceId
    connectDevice(device)
    void refreshAll().then(() => loadCost())
  }
})
</script>

<template>
  <view :class="rootClass">
    <MossVeil />

    <!-- 启动动画：每次冷启动出现一次，任意位置点击可跳过 -->
    <MossBoot v-if="booting" @done="onBootDone" />

    <MossSheet
      :visible="sheet.visible"
      :kind="sheet.kind"
      :title="sheet.title"
      :items="sheet.items ?? []"
      :message="sheet.message ?? ''"
      :value="sheet.value ?? ''"
      :placeholder="sheet.placeholder ?? ''"
      :confirm-text="sheet.confirmText ?? '确定'"
      @update:visible="sheet.visible = $event"
      @select="onSheetSelect"
      @confirm="onSheetConfirm"
    />

    <view class="layout">
      <scroll-view scroll-y class="feed">
        <view class="wrap">
          <!-- 品牌区：这说明"这是什么"，也说明"现在该干什么" -->
          <view class="top">
            <view class="brand">
              <MossBadge :size="30" :working="anyWorking" :glow="!state.lite" />
              <view class="brand-txt">
                <view class="brand-line">
                  <text class="logo mono">MOSS<text class="logo-acc">AI</text></text>
                  <view class="app-tag mono">APP</view>
                </view>
                <text class="tagline">设备与配对 · 连上电脑，任务继续跑</text>
              </view>
            </view>
            <view class="top-actions">
              <view class="iconbtn" :class="{ spin: refreshing }" @tap="refresh">
                <text class="glyph">↻</text>
              </view>
              <view class="iconbtn" @tap="toggleTheme">
                <text class="glyph">{{ state.light ? '☾' : '☀' }}</text>
              </view>
            </view>
          </view>

          <!-- 一行统计：不占一张卡的位置，但让"有几台在线"一眼可见。
               没有设备时整行不出现——"0 台在线 · 0 台设备"是零信息量。 -->
          <view v-if="state.devices.length > 0" class="strip">
            <view class="strip-i">
              <view class="strip-dot" />
              <text class="strip-n mono">{{ onlineCount }}</text>
              <text>台在线</text>
            </view>
            <text class="strip-sep">·</text>
            <view class="strip-i">
              <text class="strip-n mono">{{ state.devices.length }}</text>
              <text>台设备</text>
            </view>
            <view v-if="state.waiting > 0" class="strip-warn">
              <text class="mono">{{ state.waiting }}</text>
              <text> 项待处理</text>
            </view>
          </view>

          <!-- 待确认配对：连得上但还没认证。单独一块，不和已配对设备混排 -->
          <view v-if="needAuth.length > 0" class="block">
            <view class="block-head">
              <text class="block-t">待确认配对</text>
              <text class="block-n mono">{{ needAuth.length }}</text>
            </view>
            <view
              v-for="d in needAuth"
              :key="`p-${d.deviceId}`"
              class="pairing"
              @tap="openPairFor(d)"
            >
              <view class="pairing-ico"><text class="mono">⌁</text></view>
              <view class="pairing-body">
                <text class="pairing-t">{{ d.name }}</text>
                <text class="pairing-d">已找到这台电脑，输入它显示的 6 位码即可确认</text>
                <text v-if="d.endpoint?.url" class="pairing-addr mono">{{ d.endpoint.url }}</text>
              </view>
              <view class="pairing-btn"><text>输入配对码</text></view>
            </view>
          </view>

          <!-- 设备卡列表 -->
          <view class="block">
            <view class="block-head">
              <text class="block-t">我的电脑</text>
              <text class="block-n mono">{{ pairedDevices.length }}</text>
              <text v-if="refreshing" class="block-sync mono">同步中…</text>
            </view>

            <view
              v-for="d in pairedDevices"
              :key="d.deviceId"
              class="dev"
              :class="{
                current: isActive(d),
                locked: d.lock?.locked === true,
                off: statusOf(d) === 'offline',
              }"
              @tap="open(d)"
              @longpress="deviceMenu(d)"
            >
              <view class="dev-head">
                <view class="dev-dot"><MossDot :status="statusOf(d)" /></view>
                <view class="dev-id">
                  <view class="dev-name-row">
                    <text class="dev-name">{{ d.name }}</text>
                    <view v-if="d.lock?.locked" class="pill danger">锁屏</view>
                    <view v-else-if="isActive(d)" class="pill acc">当前</view>
                    <view v-if="d.conn === 'needs-auth'" class="pill warn">需配对</view>
                  </view>
                  <text class="dev-host mono">{{ hostLine(d) }}</text>
                </view>
                <view class="dev-lat">
                  <text class="dev-lat-v mono" :class="latencyTone(d)">{{ latencyText(d) }}</text>
                  <text class="dev-lat-k">延迟</text>
                </view>
                <view class="dev-more" @tap.stop="deviceMenu(d)"><text>⋯</text></view>
              </view>

              <!-- 这台设备的数据量：会话 / 运行中 / 待处理 / 本地条目 -->
              <view class="metrics">
                <view class="metric">
                  <text class="metric-v mono">{{ totalText(d) }}</text>
                  <text class="metric-k">会话</text>
                </view>
                <view class="metric">
                  <text class="metric-v mono">{{ sessionStats(d).running }}</text>
                  <text class="metric-k">运行中</text>
                </view>
                <view class="metric">
                  <text class="metric-v mono">{{ sessionStats(d).waiting }}</text>
                  <text class="metric-k">待处理</text>
                </view>
                <view v-if="dataVolume(d) !== undefined" class="metric">
                  <text class="metric-v mono">{{ dataVolume(d) }}</text>
                  <text class="metric-k">本地条目</text>
                </view>
              </view>

              <!-- 费用与峰谷：宿主没装 dsh-cost-meter 时整行不出现 -->
              <view
                v-if="d.deviceId === state.activeId && (costText().length > 0 || peakText().length > 0)"
                class="dev-cost"
              >
                <text v-if="costText().length > 0" class="cost mono">累计 {{ costText() }}</text>
                <text v-if="peakText().length > 0" class="peak mono" :class="peakTone()">{{ peakText() }}</text>
              </view>

              <view class="dev-foot">
                <text class="dev-state" :class="statusOf(d)">{{ statusText(statusOf(d)) }}</text>
                <view v-if="d.lock?.locked" class="dev-unlock" @tap.stop="requestUnlock">
                  <text>请求解锁</text>
                </view>
                <view class="grow" />
                <text class="dev-go">进入工作台 ›</text>
              </view>
            </view>

            <!-- 空态：两个真入口，不摆假设备卡，也不显示"0 台在线" -->
            <view v-if="state.devices.length === 0" class="empty">
              <text class="empty-t">还没有配对设备</text>
              <text class="empty-d">
                在电脑上打开 MOSS Link → 生成配对码，用手机扫码或输入 6 位码。
                也可以先不连电脑，直接用本地域。
              </text>
              <view class="empty-acts">
                <view class="empty-btn primary" @tap="addDevice"><text>扫码配对</text></view>
                <view class="empty-btn ghost" @tap="goLocal"><text>直接进本地域</text></view>
              </view>
            </view>
          </view>

          <!-- 本地域入口：不连电脑也能用 -->
          <view class="local" :class="{ on: isLocal }" @tap="goLocal">
            <view class="local-ico"><text class="mono">▤</text></view>
            <view class="local-body">
              <view class="local-head">
                <text class="local-t">本地域</text>
                <view v-if="isLocal" class="pill acc">当前</view>
              </view>
              <text class="local-d">不连电脑也能用：任务 / 日历 / 专注 / 笔记（无会话与 AI）</text>
            </view>
            <text class="local-chev">›</text>
          </view>

          <view class="foot">
            <text>数据不经过任何服务器</text>
            <text class="mono"> / E2E</text>
          </view>
        </view>
      </scroll-view>

      <!-- 主操作：固定在底部，拇指可达；底部避开 home indicator -->
      <view class="dock">
        <view class="dock-inner">
          <view class="cta" @tap="addDevice">
            <text class="cta-plus">＋</text>
            <text class="cta-t">扫码配对</text>
          </view>
          <view class="dock-alt" @tap="addDevice">
            <text>或输入 6 位配对码</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 锁屏浮层：手机上仍可看，只是不能写 -->
    <view v-if="state.lockDialogFor" class="mask" @tap="dismiss">
      <view class="sheet" @tap.stop>
        <view class="sheet-grab" />
        <view class="sheet-head">
          <view class="sheet-titles">
            <text class="sheet-t">这台电脑处于锁定状态</text>
            <text class="sheet-s">你可以请求解锁：电脑上会弹出确认框，30 秒内不确认将自动拒绝。</text>
          </view>
          <view class="sheet-x" @tap="dismiss"><text>×</text></view>
        </view>
        <view class="sheet-acts">
          <view class="btn ghost" @tap="dismiss"><text>取消</text></view>
          <view class="btn primary" @tap="requestUnlock"><text>请求解锁</text></view>
        </view>
      </view>
    </view>

    <!-- 配对面板：扫码是主路径，手输是保底。流程与旧版一致 -->
    <view v-if="pairOpen" class="mask" @tap="closePair">
      <view class="sheet" @tap.stop>
        <view class="sheet-grab" />
        <view class="sheet-head">
          <view class="sheet-titles">
            <text class="sheet-t">配对电脑</text>
            <text class="sheet-s">在电脑上打开 MOSS Link → 生成配对码。扫码自动填地址与码，也可以手动输入。</text>
          </view>
          <view class="sheet-x" @tap="closePair"><text>×</text></view>
        </view>

        <!-- 扫码是主路径：一次拿到地址+码，不用手抄 ws:// -->
        <!-- 图标用纯 CSS 画：App 端对内联 SVG 不稳定，会"图标消失但文字在" -->
        <view class="scan-btn" :class="{ 'is-disabled': pairBusy }" @tap="scanToPair">
          <view class="scan-ico">
            <view class="scan-corner tl" />
            <view class="scan-corner tr" />
            <view class="scan-corner bl" />
            <view class="scan-corner br" />
            <view class="scan-line" />
          </view>
          <text class="scan-t">扫码配对</text>
        </view>

        <view class="or-row"><view class="or-line" /><text class="or-t">或手动输入</text><view class="or-line" /></view>

        <input
          v-model="pairInput"
          class="pair-input mono"
          :class="{ shake: pairShake }"
          type="number"
          maxlength="6"
          placeholder="000000"
          :disabled="pairBusy"
        />

        <!-- 首次配对时本地还没有 endpoint，必须让用户填一次地址 -->
        <input
          v-if="needsAddress"
          v-model="pairAddress"
          class="addr-input mono"
          type="text"
          placeholder="ws://192.168.1.23:7443/dshlink"
          :disabled="pairBusy"
        />

        <text v-if="pairError" class="pair-err">{{ pairError }}</text>

        <view class="sheet-acts">
          <view class="btn ghost" @tap="closePair"><text>取消</text></view>
          <!-- 忙碌时必须视觉禁用：只改文案用户会反复点，重复配对请求 -->
          <view class="btn primary" :class="{ 'is-disabled': pairBusy }" @tap="finishPair">
            <text>{{ pairBusy ? '配对中…' : '配对' }}</text>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
/**
 * 这一页是独立全屏，不再套 PageShell：
 * 根节点自己撑满视口 + 顶开状态栏（.dsh 的 padding-top 由 moss.scss 统一给），
 * 内容列分成「可滚动的 feed」与「常驻底部的 dock」两段。
 */
.idx {
  height: 100vh;
  height: 100dvh;
  overflow: hidden;

  /* 卡片阴影与遮罩：深色下用近黑、浅色下用强调色的淡淡投影，都从 var() 推导 */
  --card-shadow: 0 10px 26px color-mix(in srgb, var(--bg-grad-3) 78%, transparent);
  --mask-bg: color-mix(in srgb, var(--bg-grad-3) 80%, transparent);
  --cta-shadow: 0 14px 30px color-mix(in srgb, var(--acc) 26%, transparent);
}

.idx.is-light {
  --card-shadow: 0 8px 22px color-mix(in srgb, var(--acc) 10%, transparent);
  --mask-bg: color-mix(in srgb, var(--t1) 42%, transparent);
  --cta-shadow: 0 12px 26px color-mix(in srgb, var(--acc) 22%, transparent);
}

.layout {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.feed {
  flex: 1;
  min-height: 0;
}

.wrap {
  width: 100%;
  max-width: var(--content-max);
  margin: 0 auto;
  padding: 0 var(--gutter) 18px;
}

/* ── 品牌区 ─────────────────────────────────────────────────────────── */

.top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0 12px;
}

.brand {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-txt {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.brand-line {
  display: flex;
  align-items: center;
  gap: 7px;
}

.logo {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 2.4px;
  color: var(--t1);
  line-height: 1;
}

.logo-acc { color: var(--acc); margin-left: 1px; }

.app-tag {
  font-size: 8.5px;
  letter-spacing: 1.2px;
  padding: 1px 5px;
  border-radius: 5px;
  border: 1px solid var(--bd);
  color: var(--t3);
  line-height: 1.5;
}

.tagline {
  font-size: 11.5px;
  color: var(--t3);
  letter-spacing: 0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.top-actions { display: flex; gap: 8px; flex: none; }

.iconbtn {
  width: 34px;
  height: 34px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  border: 1px solid var(--bd);
  background: var(--s1);
  color: var(--t2);
  box-shadow: var(--card-shadow);
  transition: transform var(--t-fast) var(--ease-out);
}

.iconbtn:active { transform: scale(0.94); }

.iconbtn.spin .glyph { animation: spin 900ms linear infinite; }

.glyph { font-size: 15px; line-height: 1; }

@keyframes spin { to { transform: rotate(360deg); } }

/* ── 统计条 ─────────────────────────────────────────────────────────── */

.strip {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 0 2px 2px;
  font-size: 11.5px;
  color: var(--t3);
}

.strip-i { display: flex; align-items: baseline; gap: 4px; }
.strip-n { font-size: 13px; font-weight: 700; color: var(--t1); }
.strip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--acc);
  align-self: center;
}
.strip-sep { opacity: 0.5; margin: 0 2px; }

.strip-warn {
  margin-left: auto;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 10.5px;
  letter-spacing: 0.02em;
}

/* ── 区块标题 ───────────────────────────────────────────────────────── */

.block { margin-top: 16px; }

.block-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 2px;
  margin-bottom: 8px;
}

.block-t {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--t2);
}

.block-n {
  font-size: 10.5px;
  color: var(--t3);
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--s2);
}

.block-sync { margin-left: auto; font-size: 10px; color: var(--acc); }

/* ── 待确认配对卡 ───────────────────────────────────────────────────── */

.pairing {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  margin-bottom: 8px;
  border-radius: var(--r-lg);
  border: 1px solid color-mix(in srgb, var(--warn) 34%, transparent);
  background: linear-gradient(180deg, var(--warn-soft), var(--s1) 78%);
  box-shadow: var(--card-shadow);
}

.pairing:active { transform: scale(0.992); }

.pairing-ico {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 17px;
}

.pairing-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pairing-t {
  font-size: 14px;
  font-weight: 600;
  color: var(--t1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pairing-d { font-size: 11px; line-height: 16px; color: var(--t2); }
.pairing-addr {
  font-size: 10px;
  color: var(--t3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pairing-btn {
  flex: none;
  height: 32px;
  padding: 0 11px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  border: 1px solid var(--bd-strong);
  background: var(--s1);
  color: var(--acc);
  font-size: 11.5px;
  font-weight: 600;
}

/* ── 设备卡 ─────────────────────────────────────────────────────────── */

.dev {
  position: relative;
  padding: 13px 13px 11px;
  margin-bottom: 10px;
  border-radius: var(--r-lg);
  border: 1px solid var(--bd);
  background: var(--s1);
  box-shadow: var(--card-shadow);
  transition: transform var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out);
  overflow: hidden;
}

.dev:active { transform: scale(0.992); }

/* 当前设备：描边加深，表示"点进去就是这台" */
.dev.current { border-color: var(--bd-strong); }

/* 锁屏：整张卡染成警戒色，但只有这一张——不整页变红 */
.dev.locked {
  border-color: var(--danger-bd);
  background: linear-gradient(180deg, var(--danger-soft), var(--s1) 70%);
}

/* 离线：抽掉"发光"，但保留可读性 */
.dev.off { background: var(--s2); border-color: var(--bd); }
.dev.off .dev-name { color: var(--t2); }
.dev.off .dev-state { color: var(--t3); }

.dev-head { display: flex; align-items: flex-start; gap: 9px; }

.dev-dot { flex: none; padding-top: 5px; }

.dev-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }

.dev-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }

.dev-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--t1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dev-host {
  font-size: 10.5px;
  color: var(--t3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dev-lat {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  padding-top: 1px;
}

.dev-lat-v { font-size: 12px; font-weight: 700; line-height: 1.2; }
.dev-lat-v.ok { color: var(--ok); }
.dev-lat-v.mid { color: var(--warn); }
.dev-lat-v.slow { color: var(--danger); }
.dev-lat-v.dim { color: var(--t3); }
.dev-lat-k { font-size: 9px; color: var(--t3); letter-spacing: 0.04em; }

.dev-more {
  flex: none;
  width: 26px;
  height: 26px;
  margin: -3px -4px 0 2px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--t3);
  font-size: 15px;
  line-height: 1;
}

.dev-more:active { background: var(--s2); color: var(--t2); }

/* ── 设备数据量 ─────────────────────────────────────────────────────── */

.metrics {
  display: flex;
  align-items: stretch;
  gap: 6px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--bd);
}

.metric {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.metric-v { font-size: 14px; font-weight: 700; color: var(--t1); line-height: 1.2; }
.metric-k { font-size: 9.5px; color: var(--t3); white-space: nowrap; }

.dev-cost {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.cost { font-size: 10.5px; color: var(--t2); }
.peak { font-size: 10px; }
.peak.peak { color: var(--warn); }
.peak.valley { color: var(--acc); }

.dev-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
}

.dev-state { font-size: 10.5px; color: var(--t2); letter-spacing: 0.02em; }
.dev-state.online { color: var(--acc); }
.dev-state.connecting { color: var(--warn); }
.dev-state.locked { color: var(--danger); }
.dev-state.needs-auth { color: var(--warn); }

.dev-unlock {
  height: 24px;
  padding: 0 9px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  border: 1px solid var(--danger-bd);
  color: var(--danger);
  font-size: 10.5px;
  font-weight: 600;
}

.dev-unlock:active { background: var(--danger-soft); }

.grow { flex: 1; }

.dev-go { font-size: 10.5px; color: var(--t3); }

/* ── 空态 ───────────────────────────────────────────────────────────── */

.empty {
  padding: 18px 15px;
  border-radius: var(--r-lg);
  border: 1px dashed var(--bd);
  background: var(--s1);
}

.empty-t { display: block; font-size: 14px; font-weight: 600; color: var(--t1); }
.empty-d {
  display: block;
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 18px;
  color: var(--t2);
}

.empty-acts { display: flex; gap: 8px; margin-top: 12px; }

.empty-btn {
  flex: 1;
  height: 38px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12.5px;
  font-weight: 600;
  border: 1px solid var(--bd);
  color: var(--t2);
}

.empty-btn:active { transform: scale(0.98); }
.empty-btn.primary { background: var(--acc); border-color: transparent; color: var(--acc-ink); }
.empty-btn.ghost { background: var(--s2); }

/* ── 本地域入口 ─────────────────────────────────────────────────────── */

.local {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-top: 16px;
  padding: 13px;
  border-radius: var(--r-lg);
  border: 1px solid var(--bd);
  background: linear-gradient(150deg, var(--s1), var(--s2));
  box-shadow: var(--card-shadow);
  transition: transform var(--t-fast) var(--ease-out);
}

.local:active { transform: scale(0.992); }
.local.on { border-color: var(--bd-strong); }

.local-ico {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  border: 1px solid var(--bd);
  background: var(--acc-soft);
  color: var(--acc);
  font-size: 15px;
}

.local-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.local-head { display: flex; align-items: center; gap: 6px; }
.local-t { font-size: 14px; font-weight: 600; color: var(--t1); }
.local-d { font-size: 11px; line-height: 16px; color: var(--t2); }
.local-chev { flex: none; font-size: 18px; color: var(--t3); }

/* ── 页脚 ───────────────────────────────────────────────────────────── */

.foot {
  margin-top: 18px;
  text-align: center;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--t3);
  opacity: 0.8;
}

/* ── 底部主操作 ─────────────────────────────────────────────────────── */

.dock {
  flex: none;
  padding: 10px var(--gutter) calc(var(--safe-bottom-real, env(safe-area-inset-bottom)) + 8px);
  background: linear-gradient(180deg, transparent, var(--bg-grad-2) 42%, var(--bg));
}

.dock-inner {
  width: 100%;
  max-width: var(--content-max);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cta {
  height: 52px;
  border-radius: var(--r-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  background: var(--acc);
  color: var(--acc-ink);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  box-shadow: var(--cta-shadow);
  transition: transform var(--t-fast) var(--ease-out);
}

.cta:active { transform: scale(0.975); }

.cta-plus { font-size: 17px; line-height: 1; }
.cta-t { line-height: 1; }

.dock-alt {
  text-align: center;
  font-size: 10.5px;
  color: var(--t3);
  letter-spacing: 0.03em;
  padding: 2px 0 0;
}

.dock-alt:active { color: var(--t2); }

/* ── 弹层：底部升起的卡片，与全站同一套语言 ─────────────────────────── */

.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 16px 16px calc(var(--safe-bottom-real, 16px) + 14px);
  background: var(--mask-bg);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.sheet {
  width: 100%;
  max-width: 520px;
  max-height: calc(100vh - 60px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 8px 16px 16px;
  border-radius: var(--r-lg);
  border: 1px solid var(--bd);
  background: var(--s1);
  box-shadow: var(--card-shadow);
  animation: rise var(--t-mid) var(--ease-out);
}

@keyframes rise {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: none; }
}

.sheet-grab {
  width: 34px;
  height: 3px;
  margin: 0 auto 10px;
  border-radius: 2px;
  background: var(--bd-strong);
}

.sheet-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.sheet-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.sheet-t { font-size: 15px; font-weight: 700; color: var(--t1); }
.sheet-s { font-size: 11.5px; line-height: 18px; color: var(--t2); }

.sheet-x {
  flex: none;
  width: 28px;
  height: 28px;
  margin: -2px -2px 0 0;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--t3);
  font-size: 17px;
  line-height: 1;
}

.sheet-x:active { background: var(--s2); color: var(--t2); }

.sheet-acts { display: flex; gap: 10px; margin-top: 16px; }
.sheet-acts .btn { flex: 1; }

/* ── 扫码按钮 ───────────────────────────────────────────────────────── */

.scan-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 50px;
  margin-top: 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd-strong);
  background: var(--acc-soft);
  color: var(--acc);
  font-size: 14px;
  font-weight: 600;
}

.scan-btn:active { transform: scale(0.985); }

/* 扫码图标：四个角 + 扫描线，纯 CSS */
.scan-ico {
  position: relative;
  width: 20px;
  height: 20px;
  flex: none;
}

.scan-corner {
  position: absolute;
  width: 7px;
  height: 7px;
  border: 2px solid currentColor;
}

.scan-corner.tl { top: 0; left: 0; border-right: 0; border-bottom: 0; border-top-left-radius: 2px; }
.scan-corner.tr { top: 0; right: 0; border-left: 0; border-bottom: 0; border-top-right-radius: 2px; }
.scan-corner.bl { bottom: 0; left: 0; border-right: 0; border-top: 0; border-bottom-left-radius: 2px; }
.scan-corner.br { bottom: 0; right: 0; border-left: 0; border-top: 0; border-bottom-right-radius: 2px; }

.scan-line {
  position: absolute;
  left: 2px;
  right: 2px;
  top: 50%;
  height: 2px;
  margin-top: -1px;
  border-radius: 1px;
  background: currentColor;
}

.scan-t { line-height: 1; }

/* ── 配对输入 ───────────────────────────────────────────────────────── */

.or-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0 2px;
}

.or-line { flex: 1; height: 1px; background: var(--bd); }
.or-t { font-size: 10px; letter-spacing: 0.08em; color: var(--t3); }

.pair-input {
  width: 100%;
  height: 50px;
  margin: 12px 0 6px;
  padding: 0 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd-strong);
  background: var(--bg);
  color: var(--t1);
  font-size: 23px;
  letter-spacing: 10px;
  text-align: center;
}

.addr-input {
  width: 100%;
  height: 42px;
  margin-top: 8px;
  padding: 0 12px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--bg);
  color: var(--t2);
  font-size: 12px;
}

.pair-err {
  display: block;
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 17px;
  color: var(--danger);
}

/* ── 通用小标签 ─────────────────────────────────────────────────────── */

.pill {
  flex: none;
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 9.5px;
  line-height: 1.6;
  letter-spacing: 0.02em;
}

.pill.acc { background: var(--acc-soft); color: var(--acc); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.danger { background: var(--danger-soft); color: var(--danger); }

.shake { animation: shake 260ms var(--ease-out); }

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-5px); }
  75% { transform: translateX(5px); }
}

/* 减少动效偏好：关掉弹层升起、抖动与图标旋转 */
@media (prefers-reduced-motion: reduce) {
  .sheet,
  .shake,
  .iconbtn.spin .glyph {
    animation: none !important;
  }
}
</style>
