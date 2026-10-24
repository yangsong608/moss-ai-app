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

    <!-- 极光只做静态渐变层的 transform 漂移；装饰层不接收事件。 -->
    <view class="aurora aurora-a" />
    <view class="aurora aurora-b" />

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
          <!-- 品牌状态台：品牌、标题、在线读数与连接状态集中在一层。 -->
          <view class="hero enter">
            <view class="hero-scan" />
            <!-- 行1：品牌 + 标题 + 状态 + 操作（四合一，去掉单独品牌行与大数字读数） -->
            <view class="hero-head">
              <MossBadge :size="30" :working="anyWorking" :glow="!state.lite" />
              <view class="hero-head-txt">
                <text class="hero-head-t">设备与配对</text>
                <text class="hero-head-s mono">MOSS REMOTE CONSOLE</text>
              </view>
              <view class="status-pill" :class="{ idle: onlineCount === 0 }">
                <view class="status-pill-dot" />
                <text>{{ onlineCount > 0 ? '链路在线' : needAuth.length > 0 ? '等待确认' : '等待连接' }}</text>
              </view>
              <view class="top-actions">
                <view
                  class="iconbtn"
                  :class="{ spin: refreshing }"
                  role="button"
                  aria-label="刷新设备"
                  @tap="refresh"
                >
                  <text class="glyph">↻</text>
                </view>
                <view
                  class="iconbtn"
                  role="button"
                  :aria-label="state.light ? '切换深色主题' : '切换浅色主题'"
                  @tap="toggleTheme"
                >
                  <text class="glyph">{{ state.light ? '☾' : '☀' }}</text>
                </view>
              </view>
            </view>

            <!-- 行2：统计收成一行 chip，不再三格大数字 -->
            <view class="hero-chips">
              <view class="hchip">
                <text class="hchip-v mono">{{ String(onlineCount).padStart(2, '0') }}</text>
                <text class="hchip-k">在线</text>
              </view>
              <view class="hchip">
                <text class="hchip-v mono">{{ pairedDevices.length }}</text>
                <text class="hchip-k">已配对</text>
              </view>
              <view class="hchip" :class="{ warn: needAuth.length > 0 }">
                <text class="hchip-v mono">{{ needAuth.length }}</text>
                <text class="hchip-k">待确认</text>
              </view>
              <view class="hchip" :class="{ warn: state.waiting > 0 }">
                <text class="hchip-v mono">{{ state.waiting }}</text>
                <text class="hchip-k">待处理</text>
              </view>
              <text class="hchip-live mono">LIVE / {{ refreshing ? 'SYNC' : 'READY' }}</text>
            </view>

            <!-- 行3：配对操作 -->
            <view class="hero-pair">
              <view class="hero-cta" @tap="addDevice">
                <text class="hero-cta-plus">＋</text>
                <text class="hero-cta-t">扫码配对</text>
                <text class="hero-cta-code mono">PAIR</text>
              </view>
              <view class="hero-pair-alt" @tap="addDevice">
                <text>或输入 6 位配对码</text><text class="hero-pair-arrow">↗</text>
              </view>
            </view>
          </view>

          <!-- 待确认配对：独立成块，主列表由 pairedDevices 保证不重复。 -->
          <view v-if="needAuth.length > 0" class="block auth-block">
            <view class="block-head">
              <view class="block-heading">
                <text class="block-t">待确认配对</text>
                <text class="block-code mono">ACTION REQUIRED</text>
              </view>
              <text class="block-n mono">{{ needAuth.length }}</text>
            </view>
            <view
              v-for="(d, index) in needAuth"
              :key="`p-${d.deviceId}`"
              class="pairing"
              :class="{ enter: index < 8 }"
              :style="index < 8 ? { animationDelay: `${index * 45}ms` } : undefined"
              @tap="openPairFor(d)"
            >
              <view class="pairing-ico"><text class="mono">⌁</text></view>
              <view class="pairing-body">
                <text class="pairing-t">{{ d.name }}</text>
                <text class="pairing-d">已找到电脑，输入它显示的 6 位码完成确认</text>
                <text v-if="d.endpoint?.url" class="pairing-addr mono">{{ d.endpoint.url }}</text>
              </view>
              <view class="pairing-btn"><text>去确认</text><text class="pairing-arrow">›</text></view>
            </view>
          </view>

          <!-- 设备卡列表 -->
          <view class="block devices-block">
            <view class="block-head">
              <view class="block-heading">
                <text class="block-t">设备矩阵</text>
                <text class="block-code mono">PAIRED NODES</text>
              </view>
              <text class="block-n mono">{{ pairedDevices.length }}</text>
              <text v-if="refreshing" class="block-sync mono">同步中…</text>
            </view>

            <view
              v-for="(d, index) in pairedDevices"
              :key="d.deviceId"
              class="dev"
              :class="{
                enter: index < 8,
                current: isActive(d),
                'is-online': statusOf(d) === 'online',
                locked: d.lock?.locked === true,
                off: statusOf(d) === 'offline',
              }"
              :style="index < 8 ? { animationDelay: `${index * 45}ms` } : undefined"
              @tap="open(d)"
              @longpress="deviceMenu(d)"
            >
              <!-- 仅在线设备渲染旋转渐变；mask 只留下 1px 外圈。 -->
              <view v-if="statusOf(d) === 'online'" class="dev-rim"><view class="dev-flow" /></view>
              <view class="dev-head dev-content">
                <view class="dev-dot">
                  <view v-if="statusOf(d) === 'online'" class="radar-ring" />
                  <MossDot :status="statusOf(d)" />
                </view>
                <view class="dev-id">
                  <view class="dev-name-row">
                    <text class="dev-name">{{ d.name }}</text>
                    <view v-if="d.lock?.locked" class="pill danger">锁屏</view>
                    <view v-else-if="isActive(d)" class="pill acc">当前</view>
                  </view>
                  <text class="dev-host mono">{{ hostLine(d) }}</text>
                </view>
                <view class="dev-lat">
                  <text class="dev-lat-v mono" :class="latencyTone(d)">{{ latencyText(d) }}</text>
                  <text class="dev-lat-k mono">LATENCY</text>
                </view>
                <view class="dev-more" role="button" aria-label="设备管理" @tap.stop="deviceMenu(d)"><text>⋯</text></view>
              </view>

              <!-- 固定四格；未加载的数据以 — 表示，不把未知误报成 0。 -->
              <view class="metrics dev-content">
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
                <view class="metric">
                  <text class="metric-v mono">{{ dataVolume(d) ?? '—' }}</text>
                  <text class="metric-k">本地条目</text>
                </view>
              </view>

              <view
                v-if="d.deviceId === state.activeId && (costText().length > 0 || peakText().length > 0)"
                class="dev-cost dev-content"
              >
                <text v-if="costText().length > 0" class="cost mono">累计 {{ costText() }}</text>
                <text v-if="peakText().length > 0" class="peak mono" :class="peakTone()">{{ peakText() }}</text>
              </view>

              <view class="dev-foot dev-content">
                <view class="dev-status">
                  <view class="dev-status-mark" :class="statusOf(d)" />
                  <text class="dev-state" :class="statusOf(d)">{{ statusText(statusOf(d)) }}</text>
                </view>
                <view v-if="d.lock?.locked" class="dev-unlock" @tap.stop="requestUnlock">
                  <text>请求解锁</text>
                </view>
                <view class="grow" />
                <view class="dev-go"><text>进入工作台</text><text class="dev-go-arrow">›</text></view>
              </view>
            </view>

            <!-- 空态：保留扫码与直接进入本地域两个真入口。 -->
            <view v-if="state.devices.length === 0" class="empty enter">
              <view class="empty-signal"><view /><view /><view /></view>
              <text class="empty-t">等待第一台电脑接入</text>
              <text class="empty-d">在电脑端 MOSS Link 生成配对码，扫码即可连接；也可以先使用本地域。</text>
              <view class="empty-acts">
                <view class="empty-btn primary" @tap="addDevice"><text>扫码配对</text></view>
                <view class="empty-btn ghost" @tap="goLocal"><text>直接进本地域</text></view>
              </view>
            </view>
          </view>

          <!-- 本地域：虚线、存储图标与较低对比材质，和远程主机明确区分。 -->
          <view
            class="local enter"
            :class="{ on: isLocal }"
            :style="{ animationDelay: `${Math.min(pairedDevices.length, 7) * 45}ms` }"
            @tap="goLocal"
          >
            <view class="local-ico"><view class="local-glyph" /></view>
            <view class="local-body">
              <view class="local-head">
                <text class="local-t">本地域</text>
                <text class="local-code mono">ON THIS DEVICE</text>
                <view v-if="isLocal" class="pill acc">当前</view>
              </view>
              <text class="local-d">不连电脑也能用：任务 / 日历 / 专注 / 笔记（无会话与 AI）</text>
            </view>
            <text class="local-chev">›</text>
          </view>

          <view class="foot">
            <view class="foot-lock" />
            <text>数据不经过任何服务器</text>
            <text class="mono"> / END-TO-END</text>
          </view>
        </view>
      </scroll-view>
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
          <view class="btn primary" :class="{ 'is-disabled': pairBusy }" @tap="finishPair">
            <text>{{ pairBusy ? '配对中…' : '配对' }}</text>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
/* 独立全屏控制台。仅 transform/opacity 参与动画，无 blur/backdrop-filter/canvas。 */
.idx {
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  --r-console: 20px;
  --glass-top: color-mix(in srgb, var(--s1) 88%, transparent);
  --glass-bottom: color-mix(in srgb, var(--s1) 76%, transparent);
  --glass-hi: color-mix(in srgb, var(--t1) 12%, transparent);
  --card-shadow: 0 10px 28px color-mix(in srgb, var(--bg-grad-3) 12%, transparent);
  --mask-bg: color-mix(in srgb, var(--bg-grad-3) 80%, transparent);
  --cta-shadow: 0 10px 28px color-mix(in srgb, var(--acc) 24%, transparent);
  transition: background-color 160ms ease-out, color 160ms ease-out;
}

.idx.is-light {
  --glass-top: color-mix(in srgb, var(--s1) 82%, transparent);
  --glass-bottom: color-mix(in srgb, var(--s1) 66%, transparent);
  --glass-hi: color-mix(in srgb, var(--s1) 90%, transparent);
  --card-shadow: 0 10px 28px color-mix(in srgb, var(--acc) 10%, transparent);
  --mask-bg: color-mix(in srgb, var(--t1) 42%, transparent);
  --cta-shadow: 0 10px 24px color-mix(in srgb, var(--acc) 20%, transparent);
}

/* 两个静态径向渐变层漂移，渐变本身不参与动画。 */
.aurora {
  position: absolute;
  z-index: 0;
  width: 118%;
  height: 56%;
  left: -9%;
  pointer-events: none;
  opacity: 0.75;
  background:
    radial-gradient(ellipse at 26% 36%, var(--acc-soft), transparent 58%),
    radial-gradient(ellipse at 78% 58%, var(--acc-glow), transparent 54%);
  transform: translate3d(-3%, 0, 0);
  animation: aurora-drift 24s ease-in-out infinite alternate;
}

.aurora-a { top: -16%; }
.aurora-b {
  top: auto;
  bottom: -24%;
  opacity: 0.42;
  transform: translate3d(3%, 0, 0);
  animation-direction: alternate-reverse;
}

.is-light .aurora { opacity: 0.48; }
.is-light .aurora-b { opacity: 0.24; }

@keyframes aurora-drift {
  from { transform: translate3d(-3%, -2%, 0); }
  to { transform: translate3d(3%, 2%, 0); }
}

.layout {
  position: relative;
  z-index: 2;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.feed { flex: 1; min-height: 0; }

.wrap {
  width: 100%;
  max-width: var(--content-max);
  margin: 0 auto;
  padding: 8px var(--gutter) 20px;
}

/* ── 品牌 / 状态台 ─────────────────────────────────────────────────── */
.hero {
  position: relative;
  overflow: hidden;
  padding: 15px 16px 0;
  border: 1px solid var(--bd);
  border-radius: 22px;
  background:
    linear-gradient(125deg, var(--glass-hi), transparent 36%),
    linear-gradient(160deg, var(--glass-top), var(--glass-bottom));
  box-shadow: var(--card-shadow), inset 0 1px 0 var(--glass-hi);
  transition: background-color 160ms ease-out, border-color 160ms ease-out;
}

.hero::after {
  content: '';
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 51px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--bd-strong), transparent);
  opacity: 0.65;
  pointer-events: none;
}

.hero-scan {
  position: absolute;
  z-index: 0;
  top: 54px;
  left: 12%;
  width: 76%;
  height: 64px;
  pointer-events: none;
  opacity: 0;
  background: linear-gradient(90deg, transparent, var(--acc-soft) 28%, var(--acc-glow) 50%, var(--acc-soft) 72%, transparent);
  transform: translate3d(-48%, 0, 0);
  animation: radar-scan 4s ease-in-out infinite alternate;
}

.idx.is-dark .hero-scan { opacity: 0.24; }

@keyframes radar-scan {
  from { transform: translate3d(-48%, 0, 0); opacity: 0.12; }
  to { transform: translate3d(48%, 0, 0); opacity: 0.5; }
}

.hero-head,
.hero-chips,
.hero-pair { position: relative; z-index: 1; }

/* 行1：品牌/标题/状态/操作 一行搞定 */
.hero-head { display: flex; align-items: center; gap: 10px; }
.hero-head-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.hero-head-t { color: var(--t1); font-size: 17px; font-weight: 750; letter-spacing: -0.2px; line-height: 1.15; }
.hero-head-s { color: var(--t3); font-size: 8px; letter-spacing: 1.1px; white-space: nowrap; }

/* 行2：统计 chip 条（替代原三格大数字） */
.hero-chips { display: flex; align-items: center; gap: 7px; margin-top: 11px; flex-wrap: wrap; }
.hchip {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--bd);
  border-radius: 999px;
  background: var(--acc-soft);
}
.hchip.warn { border-color: color-mix(in srgb, var(--warn) 46%, transparent); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.hchip-v { color: var(--t1); font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; }
.hchip.warn .hchip-v { color: var(--warn); }
.hchip-k { color: var(--t3); font-size: 8px; white-space: nowrap; }
.hchip-live { margin-left: auto; color: var(--t3); font-size: 7px; letter-spacing: 0.6px; }

.top-actions { display: flex; flex: none; gap: 7px; }

.iconbtn {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--bd);
  border-radius: 11px;
  background: var(--acc-soft);
  color: var(--t2);
  transition: transform 90ms ease-out, background-color 160ms ease-out, border-color 160ms ease-out;
}
.iconbtn:active { transform: scale(0.97); }
.iconbtn.spin .glyph { animation: spin 900ms linear infinite; }
.glyph { font-size: 15px; line-height: 1; }
@keyframes spin { to { transform: rotate(360deg); } }

.status-pill {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 7px;
  border: 1px solid var(--bd);
  border-radius: 999px;
  background: var(--acc-soft);
  color: var(--acc);
  font-size: 9px;
  line-height: 1;
  white-space: nowrap;
  flex: none;
}
.status-pill.idle { color: var(--t2); }
.status-pill-dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }

/* ── 区块导航 ──────────────────────────────────────────────────────── */
.block { margin-top: 24px; }
.block-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding: 0 2px; }
.block-heading { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 9px; }
.block-t { color: var(--t1); font-size: 13px; font-weight: 650; letter-spacing: 0.4px; }
.block-code { color: var(--t3); font-size: 7.5px; letter-spacing: 1.1px; }

.block-n {
  min-width: 23px;
  padding: 2px 6px;
  border: 1px solid var(--bd);
  border-radius: 999px;
  color: var(--t2);
  background: var(--acc-soft);
  font-size: 9px;
  text-align: center;
}

.block-sync { color: var(--acc); font-size: 9px; }

/* ── 待确认配对：琥珀色静态底 + opacity 脉冲描边 ────────────────────── */
.pairing {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 10px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--warn) 46%, transparent);
  border-radius: var(--r-console);
  background: linear-gradient(130deg, var(--warn-soft), var(--glass-bottom) 70%);
  box-shadow: var(--card-shadow);
  transition: transform 120ms ease-out;
}

.pairing::after {
  content: '';
  position: absolute;
  inset: -1px;
  border: 1px solid var(--warn);
  border-radius: inherit;
  opacity: 0.1;
  pointer-events: none;
  animation: auth-pulse 2s ease-in-out infinite;
}

.pairing:active { transform: scale(0.99); }
@keyframes auth-pulse { 0%, 100% { opacity: 0.1; } 50% { opacity: 0.8; } }

.pairing-ico {
  flex: none;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  border-radius: 12px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 19px;
}

.pairing-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.pairing-t { overflow: hidden; color: var(--t1); font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.pairing-d { color: var(--t2); font-size: 10.5px; line-height: 16px; }
.pairing-addr { overflow: hidden; color: var(--t3); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }

.pairing-btn {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--warn);
  font-size: 11px;
  font-weight: 650;
}

.pairing-arrow { font-size: 18px; font-weight: 400; }

/* ── 在线玻璃设备卡 / 1px 流光边框 ──────────────────────────────────── */
.dev {
  position: relative;
  margin-bottom: 12px;
  padding: 15px 15px 12px;
  border: 1px solid var(--bd);
  border-radius: var(--r-console);
  background:
    linear-gradient(125deg, var(--glass-hi), transparent 30%),
    linear-gradient(155deg, var(--glass-top), var(--glass-bottom));
  box-shadow: var(--card-shadow), inset 0 1px 0 var(--glass-hi);
  transition: transform 120ms ease-out, border-color 160ms ease-out, background-color 160ms ease-out;
}

.dev:active { transform: scale(0.99); }
.dev.current { border-color: var(--bd-strong); }

.dev-rim {
  position: absolute;
  z-index: 0;
  inset: -1px;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
}

.dev.is-online .dev-rim { opacity: 0.9; }

.dev-flow {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 180%;
  aspect-ratio: 1;
  padding: 1px;
  border-radius: inherit;
  background: conic-gradient(from 0deg, transparent 0deg, transparent 245deg, var(--acc) 305deg, var(--glass-hi) 330deg, transparent 360deg);
  transform: translate(-50%, -50%) rotate(0deg);
  animation: rim-orbit 6s linear infinite;
  /* mask 在外层执行，保证任何旋转角度都只露出卡片的 1px 边圈。 */
}

.dev-rim {
  -webkit-mask: linear-gradient(var(--t1) 0 0) content-box, linear-gradient(var(--t1) 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(var(--t1) 0 0) content-box, linear-gradient(var(--t1) 0 0);
  mask-composite: exclude;
  padding: 1px;
}

@keyframes rim-orbit {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to { transform: translate(-50%, -50%) rotate(360deg); }
}

.dev.locked { border-color: var(--danger-bd); background: linear-gradient(150deg, var(--danger-soft), var(--glass-bottom) 65%); }
.dev.off { background: linear-gradient(155deg, var(--glass-bottom), var(--s2)); }
.dev.off .dev-name { color: var(--t2); }
.dev-content { position: relative; z-index: 1; }

.dev-head { display: flex; align-items: flex-start; gap: 10px; }
.dev-dot { position: relative; flex: none; width: 13px; height: 13px; display: grid; place-items: center; margin-top: 4px; }
.dev-dot :deep(.dot), .dev-dot :deep(.wave) { position: relative; z-index: 1; }

.radar-ring {
  position: absolute;
  z-index: 0;
  width: 12px;
  height: 12px;
  border: 1px solid var(--acc);
  border-radius: 50%;
  opacity: 0;
  animation: radar-breathe 1.8s ease-out infinite;
}

@keyframes radar-breathe {
  0% { opacity: 0.5; transform: scale(1); }
  85%, 100% { opacity: 0; transform: scale(1.9); }
}

.dev-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.dev-name-row { min-width: 0; display: flex; align-items: center; gap: 6px; }
.dev-name { overflow: hidden; color: var(--t1); font-size: 15px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.dev-host { overflow: hidden; color: var(--t3); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.dev-lat { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; padding-top: 1px; }
.dev-lat-v { font-size: 12px; font-weight: 650; line-height: 1.2; }
.dev-lat-v.ok { color: var(--ok); }
.dev-lat-v.mid { color: var(--warn); }
.dev-lat-v.slow { color: var(--danger); }
.dev-lat-v.dim { color: var(--t3); }
.dev-lat-k { color: var(--t3); font-size: 6.5px; letter-spacing: 0.5px; }

.dev-more {
  flex: none;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  margin: -4px -5px 0 0;
  border-radius: 8px;
  color: var(--t3);
  font-size: 16px;
  line-height: 1;
  transition: transform 90ms ease-out, background-color 160ms ease-out;
}

.dev-more:active { transform: scale(0.97); background: var(--s2); color: var(--t2); }

.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin-top: 15px;
  padding: 11px 0;
  border-top: 1px solid var(--bd);
  border-bottom: 1px solid var(--bd);
  background: linear-gradient(90deg, transparent, var(--acc-soft), transparent);
}

.metric { min-width: 0; display: flex; flex-direction: column; gap: 4px; padding-left: 10px; border-left: 1px solid var(--bd); }
.metric:first-child { padding-left: 0; border-left: 0; }
.metric-v { color: var(--t1); font-size: 18px; font-weight: 550; line-height: 1; font-variant-numeric: tabular-nums; }
.metric-k { color: var(--t3); font-size: 9px; white-space: nowrap; }

.dev-cost { display: flex; align-items: center; gap: 10px; margin-top: 9px; }
.cost { color: var(--t2); font-size: 10px; }
.peak { font-size: 9px; }
.peak.peak { color: var(--warn); }
.peak.valley { color: var(--acc); }
.dev-foot { display: flex; align-items: center; gap: 8px; margin-top: 11px; }
.dev-status { display: flex; align-items: center; gap: 5px; }
.dev-status-mark { width: 3px; height: 3px; border-radius: 50%; background: var(--t3); }
.dev-status-mark.online { background: var(--acc); }
.dev-status-mark.connecting { background: var(--warn); }
.dev-status-mark.locked { background: var(--danger); }
.dev-state { color: var(--t2); font-size: 10px; letter-spacing: 0.3px; }
.dev-state.online { color: var(--acc); }
.dev-state.connecting { color: var(--warn); }
.dev-state.locked { color: var(--danger); }
.dev-state.needs-auth { color: var(--warn); }

.dev-unlock {
  height: 26px;
  display: flex;
  align-items: center;
  padding: 0 9px;
  border: 1px solid var(--danger-bd);
  border-radius: 8px;
  color: var(--danger);
  font-size: 10px;
  font-weight: 650;
}

.dev-unlock:active { background: var(--danger-soft); }
.grow { flex: 1; }
.dev-go { display: flex; align-items: center; gap: 7px; color: var(--t2); font-size: 10px; }
.dev-go-arrow { color: var(--acc); font-size: 16px; line-height: 1; }

/* ── 空态：保留两个真实入口 ────────────────────────────────────────── */
.empty {
  padding: 24px 16px 18px;
  border: 1px solid var(--bd);
  border-radius: var(--r-console);
  background: linear-gradient(155deg, var(--glass-top), var(--glass-bottom));
  text-align: center;
}

.empty-signal { height: 28px; display: flex; align-items: center; justify-content: center; gap: 5px; margin-bottom: 12px; }
.empty-signal view { width: 4px; height: 12px; border-radius: 2px; background: var(--acc); opacity: 0.45; }
.empty-signal view:nth-child(2) { height: 26px; opacity: 0.9; }
.empty-signal view:nth-child(3) { height: 18px; opacity: 0.65; }
.empty-t { display: block; color: var(--t1); font-size: 15px; font-weight: 650; }
.empty-d { display: block; max-width: 310px; margin: 8px auto 0; color: var(--t2); font-size: 11px; line-height: 18px; }
.empty-acts { display: flex; gap: 9px; margin-top: 17px; }

.empty-btn {
  flex: 1;
  min-width: 0;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bd);
  border-radius: 12px;
  color: var(--t2);
  font-size: 12px;
  font-weight: 650;
  transition: transform 90ms ease-out, background-color 160ms ease-out;
}

.empty-btn:active { transform: scale(0.97); }
.empty-btn.primary { border-color: transparent; background: linear-gradient(120deg, var(--acc), color-mix(in srgb, var(--acc) 74%, var(--t1))); color: var(--acc-ink); }
.empty-btn.ghost { background: var(--s2); }

/* ── 本地域：虚线 + 独立的纯 CSS 存储图标 ───────────────────────────── */
.local {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
  padding: 15px;
  border: 1px dashed var(--bd-strong);
  border-radius: var(--r-console);
  background: linear-gradient(145deg, var(--glass-bottom), color-mix(in srgb, var(--s2) 74%, transparent));
  box-shadow: 0 10px 28px color-mix(in srgb, var(--bg-grad-3) 8%, transparent);
  transition: transform 120ms ease-out, border-color 160ms ease-out, background-color 160ms ease-out;
}

.local:active { transform: scale(0.99); }
.local.on { border-color: var(--acc); }

.local-ico {
  flex: none;
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border: 1px solid var(--bd);
  border-radius: 13px;
  background: var(--acc-soft);
}

.local-glyph { position: relative; width: 17px; height: 15px; border: 1.5px solid var(--acc); border-radius: 4px; }
.local-glyph::before { content: ''; position: absolute; left: 3px; right: 3px; top: 4px; height: 1px; background: var(--acc); }
.local-glyph::after { content: ''; position: absolute; right: 3px; bottom: 3px; width: 3px; height: 3px; border-radius: 50%; background: var(--acc); }
.local-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.local-head { display: flex; align-items: center; gap: 7px; }
.local-t { color: var(--t1); font-size: 14px; font-weight: 650; }
.local-code { color: var(--t3); font-size: 7px; letter-spacing: 0.7px; }
.local-d { color: var(--t2); font-size: 10.5px; line-height: 17px; }
.local-chev { flex: none; color: var(--acc); font-size: 20px; }

.foot { display: flex; align-items: center; justify-content: center; gap: 4px; margin-top: 22px; color: var(--t3); font-size: 8px; letter-spacing: 0.5px; opacity: 0.8; }
.foot-lock { position: relative; width: 7px; height: 6px; margin-right: 2px; border: 1px solid var(--t3); border-radius: 1px; }
.foot-lock::before { content: ''; position: absolute; left: 1px; top: -5px; width: 3px; height: 4px; border: 1px solid var(--t3); border-bottom: 0; border-radius: 3px 3px 0 0; }

/* ── 头部配对操作区（按钮放在 hero 卡内，不再有底部 dock） ───────────── */
.hero-pair { display: flex; flex-direction: column; gap: 5px; margin-top: 12px; }

.hero-cta {
  position: relative;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--acc) 78%, var(--t1));
  border-radius: 15px;
  background: linear-gradient(110deg, color-mix(in srgb, var(--acc) 82%, var(--bg)), var(--acc) 52%, color-mix(in srgb, var(--acc) 76%, var(--t1)));
  box-shadow: var(--cta-shadow, 0 8px 22px color-mix(in srgb, var(--acc) 30%, transparent)), inset 0 1px 0 var(--glass-hi, transparent);
  color: var(--acc-ink);
  font-size: 14px;
  font-weight: 750;
  letter-spacing: 0.5px;
  transition: transform 90ms ease-out, opacity 90ms ease-out;
}
.hero-cta:active { transform: scale(0.97); opacity: 0.96; }
.hero-cta-plus { position: relative; z-index: 1; font-size: 17px; line-height: 1; }
.hero-cta-t { position: relative; z-index: 1; line-height: 1; }
.hero-cta-code { position: absolute; z-index: 1; right: 13px; font-size: 7px; font-weight: 500; letter-spacing: 1px; opacity: 0.6; }

.hero-pair-alt {
  min-height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: var(--t2);
  font-size: 10px;
  letter-spacing: 0.3px;
  transition: transform 90ms ease-out, color 160ms ease-out;
}
.hero-pair-alt:active { transform: scale(0.97); color: var(--acc); }
.hero-pair-arrow { color: var(--acc); font-size: 11px; }

/* ── 弹层与配对流程（交互不变） ─────────────────────────────────────── */
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
  border: 1px solid var(--bd);
  border-radius: 22px;
  background: var(--s1);
  box-shadow: var(--card-shadow);
  animation: rise var(--t-mid) var(--ease-out);
}

@keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
.sheet-grab { width: 34px; height: 3px; margin: 0 auto 10px; border-radius: 2px; background: var(--bd-strong); }
.sheet-head { display: flex; align-items: flex-start; gap: 10px; }
.sheet-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.sheet-t { color: var(--t1); font-size: 15px; font-weight: 700; }
.sheet-s { color: var(--t2); font-size: 11.5px; line-height: 18px; }
.sheet-x { flex: none; width: 28px; height: 28px; display: grid; place-items: center; margin: -2px -2px 0 0; border-radius: 8px; color: var(--t3); font-size: 17px; line-height: 1; }
.sheet-x:active { background: var(--s2); color: var(--t2); }
.sheet-acts { display: flex; gap: 10px; margin-top: 16px; }
.sheet-acts .btn { flex: 1; }

.scan-btn {
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 14px;
  border: 1px solid var(--bd-strong);
  border-radius: var(--r-md);
  background: var(--acc-soft);
  color: var(--acc);
  font-size: 14px;
  font-weight: 600;
  transition: transform 90ms ease-out;
}

.scan-btn:active { transform: scale(0.97); }
.scan-ico { position: relative; flex: none; width: 20px; height: 20px; }
.scan-corner { position: absolute; width: 7px; height: 7px; border: 2px solid currentColor; }
.scan-corner.tl { top: 0; left: 0; border-right: 0; border-bottom: 0; border-top-left-radius: 2px; }
.scan-corner.tr { top: 0; right: 0; border-left: 0; border-bottom: 0; border-top-right-radius: 2px; }
.scan-corner.bl { bottom: 0; left: 0; border-right: 0; border-top: 0; border-bottom-left-radius: 2px; }
.scan-corner.br { bottom: 0; right: 0; border-left: 0; border-top: 0; border-bottom-right-radius: 2px; }
.scan-line { position: absolute; left: 2px; right: 2px; top: 50%; height: 2px; margin-top: -1px; border-radius: 1px; background: currentColor; }
.scan-t { line-height: 1; }
.or-row { display: flex; align-items: center; gap: 10px; margin: 12px 0 2px; }
.or-line { flex: 1; height: 1px; background: var(--bd); }
.or-t { color: var(--t3); font-size: 10px; letter-spacing: 0.8px; }

.pair-input {
  width: 100%;
  height: 50px;
  margin: 12px 0 6px;
  padding: 0 14px;
  border: 1px solid var(--bd-strong);
  border-radius: var(--r-md);
  background: var(--bg);
  color: var(--t1);
  font-size: 23px;
  letter-spacing: 10px;
  text-align: center;
}

.addr-input { width: 100%; height: 42px; margin-top: 8px; padding: 0 12px; border: 1px solid var(--bd); border-radius: var(--r-md); background: var(--bg); color: var(--t2); font-size: 12px; }
.pair-err { display: block; margin-top: 8px; color: var(--danger); font-size: 11.5px; line-height: 17px; }
.pill { flex: none; padding: 1px 6px; border-radius: 5px; font-size: 9px; line-height: 1.6; letter-spacing: 0.2px; }
.pill.acc { background: var(--acc-soft); color: var(--acc); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.danger { background: var(--danger-soft); color: var(--danger); }
.shake { animation: shake 260ms var(--ease-out); }
@keyframes shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }

/* 前 8 条设备/待确认卡 45ms 递进；之后的卡片不带 enter，无入场动画。 */
.enter { animation: card-enter 260ms var(--ease-out) both; }
.dev.enter, .pairing.enter, .local.enter { animation-duration: 220ms; animation-timing-function: ease-out; }
@keyframes card-enter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

/* 平板设备矩阵双列；入场计数仍按列表前 8 条，而非每列 8 条。 */
@media (min-width: 700px) {
  .devices-block { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; }
  .devices-block .block-head, .devices-block .empty { grid-column: 1 / -1; }
  .dev { min-width: 0; }
  .hero-head-t { font-size: 19px; }
}

/* 横屏平板：配对操作右对齐成紧凑组（不再把主按钮拉满整行） */
@media (min-width: 900px) {
  .hero-pair {
    flex-direction: row;
    justify-content: flex-end;
    align-items: center;
    gap: 14px;
    margin-top: 14px;
  }
  .hero-cta { flex: 0 0 auto; width: 196px; height: 40px; border-radius: 13px; font-size: 13.5px; }
  .hero-pair-alt {
    flex: 0 0 auto;
    min-height: 0;
    height: 40px;
    padding: 0 4px;
    white-space: nowrap;
    font-size: 11px;
  }
  .hero-cta-code { right: 12px; }
}

/* state.lite：本页全部动画关闭；:deep 同时覆盖 MossDot / MossBadge 等子组件。 */
.idx.is-lite :deep(*) { animation: none !important; transition: none !important; }
.idx.is-lite .enter { opacity: 1; transform: none; }
.idx.is-lite .aurora { display: none; }
.idx.is-lite .hero-scan { display: none; }
.idx.is-lite .dev-rim { opacity: 0.42; }
.idx.is-lite .radar-ring { opacity: 0; }

/* 系统减少动效：与 lite 一致，所有动画和本页过渡均退化。 */
@media (prefers-reduced-motion: reduce) {
  .idx :deep(*) { animation: none !important; transition: none !important; }
  .idx .enter { opacity: 1; transform: none; }
  .idx .aurora, .idx .hero-scan { display: none; }
  .idx .radar-ring { opacity: 0; }
}
</style>
