/**
 * AI 上下文携带（P2-3）。
 *
 * 场景：在任务详情 / 笔记编辑器点「问 AI」，让对话页的输入框自带一句引用，
 * 用户补完问题就能直接发——不用再手打"我刚看的那个支付模块任务…"。
 *
 * 为什么是**单槽 + 读取即清**：
 *   - 只服务"刚点过问 AI"这一次跳转；多槽会让旧引用在后续对话里复活；
 *   - 读取即清保证同一个引用不会被连续两次进入对话页重复预填；
 *   - 30 分钟过期：用户点完转头去做别的事，回来时不该再带着过期上下文。
 *
 * 存储用 uni storage（App/H5 都能用）；在没有 uni 的环境（node 测试）退化为
 * 进程内 Map，于是本文件可以被 tsc 单独编译后直接测真实实现。
 */

export interface AiContext {
  kind: 'task' | 'note'
  id: string
  title: string
  excerpt?: string
}

/** 单槽存储 key。带命名空间，避免和旧页的 dsh-link/* 混淆。 */
export const AI_CONTEXT_KEY = 'moss/ai-context'

/** 30 分钟过期。 */
export const AI_CONTEXT_TTL_MS = 30 * 60 * 1000

interface Stored {
  at: number
  ctx: AiContext
}

/** uni storage 的最小接口（只声明用到的三个方法，避免依赖 @dcloudio/types 的细枝末节）。 */
interface UniStorage {
  getStorageSync(key: string): unknown
  setStorageSync(key: string, value: unknown): void
  removeStorageSync(key: string): void
}

/** H5 兜底用的 localStorage 子集。 */
interface WebStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** node / 测试环境没有 uni：用进程内 Map 兜底，行为与 storage 一致（单槽）。 */
const memory = new Map<string, string>()

/**
 * 取 uni storage。
 *
 * 注意：H5 构建里 `window.uni` 只是一个占位对象（`{}`），真正的 API 在模块内部，
 * 所以不能只判 `typeof uni !== 'undefined'`——那样会拿到空对象，调用时抛错并被
 * 静默吞掉，表现就是"点了问 AI，对话页什么都没有"。必须检查方法是否存在。
 */
function uniStorage(): UniStorage | undefined {
  try {
    // typeof 对未声明的全局是安全的；App 端由运行时注入真正的 uni
    if (typeof uni === 'undefined' || uni === null) return undefined
    const u = uni as unknown as Partial<UniStorage>
    if (typeof u.getStorageSync !== 'function' || typeof u.setStorageSync !== 'function') return undefined
    return u as UniStorage
  } catch {
    return undefined
  }
}

/** H5 兜底：没有可用的 uni API 时直接用 localStorage（与 uni storage 一样存原始字符串）。 */
function webStorage(): WebStorage | undefined {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return undefined
    const w = localStorage as unknown as Partial<WebStorage>
    if (typeof w.getItem !== 'function' || typeof w.setItem !== 'function') return undefined
    return w as WebStorage
  } catch {
    return undefined
  }
}

function readRaw(): string {
  const storage = uniStorage()
  if (storage !== undefined) {
    try {
      const raw = storage.getStorageSync(AI_CONTEXT_KEY)
      if (typeof raw === 'string' && raw !== '') return raw
    } catch {
      /* 落到下面的兜底 */
    }
  }
  const web = webStorage()
  if (web !== undefined) {
    try {
      const raw = web.getItem(AI_CONTEXT_KEY)
      if (typeof raw === 'string' && raw !== '') return raw
    } catch {
      /* 落到内存兜底 */
    }
  }
  return memory.get(AI_CONTEXT_KEY) ?? ''
}

function writeRaw(value: string): void {
  const storage = uniStorage()
  if (storage !== undefined) {
    try {
      storage.setStorageSync(AI_CONTEXT_KEY, value)
      return
    } catch {
      /* 落到下面的兜底 */
    }
  }
  const web = webStorage()
  if (web !== undefined) {
    try {
      web.setItem(AI_CONTEXT_KEY, value)
      return
    } catch {
      /* 落到内存兜底 */
    }
  }
  memory.set(AI_CONTEXT_KEY, value)
}

function removeRaw(): void {
  const storage = uniStorage()
  if (storage !== undefined) {
    try {
      storage.removeStorageSync(AI_CONTEXT_KEY)
    } catch {
      /* 清不掉也不能让页面崩 */
    }
  }
  const web = webStorage()
  if (web !== undefined) {
    try {
      web.removeItem(AI_CONTEXT_KEY)
    } catch {
      /* 同上 */
    }
  }
  memory.delete(AI_CONTEXT_KEY)
}

/** 折叠空白 + 截断。让 prompt 永远是单行，能塞进对话页的单行输入框。 */
function oneLine(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(1, max - 1))}…`
}

function kindLabel(kind: AiContext['kind']): string {
  return kind === 'note' ? '笔记' : '任务'
}

/**
 * 运行时收敛外部数据（storage 里的旧值、手滑写坏的值）。
 * 不信任 JSON：字段类型不对就返回 undefined，调用方按"没有上下文"处理。
 */
function normalize(value: unknown): AiContext | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const o = value as Record<string, unknown>
  if (o['kind'] !== 'task' && o['kind'] !== 'note') return undefined
  if (typeof o['id'] !== 'string' || o['id'].trim() === '') return undefined
  const label = kindLabel(o['kind'])
  const title = typeof o['title'] === 'string' ? oneLine(o['title'], 60) : ''
  const excerpt = typeof o['excerpt'] === 'string' ? oneLine(o['excerpt'], 120) : ''
  return {
    kind: o['kind'],
    id: oneLine(o['id'], 48),
    title: title === '' ? `未命名${label}` : title,
    ...(excerpt === '' ? {} : { excerpt }),
  }
}

/**
 * 存一条上下文（覆盖旧槽）。
 *
 * `now` 仅供测试注入时钟；业务调用不要传。
 */
export function stashContext(ctx: AiContext, now: number = Date.now()): void {
  const clean = normalize(ctx)
  if (clean === undefined) {
    removeRaw()
    return
  }
  const stored: Stored = { at: now, ctx: clean }
  try {
    writeRaw(JSON.stringify(stored))
  } catch {
    removeRaw()
  }
}

/**
 * 取出并清空上下文（读取即清，无论是否过期 / 是否可解析）。
 *
 * `now` 仅供测试注入时钟；业务调用不要传。
 */
export function takeContext(now: number = Date.now()): AiContext | undefined {
  const raw = readRaw()
  if (raw === '') return undefined
  // 先清再解析：坏值、过期值都不该继续占着槽位
  removeRaw()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const stored = parsed as Partial<Stored>
  if (typeof stored.at !== 'number' || !Number.isFinite(stored.at)) return undefined
  if (now - stored.at > AI_CONTEXT_TTL_MS) return undefined
  return normalize(stored.ctx)
}

/**
 * 生成给 agent 的引用前缀。
 *
 * 形如：`关于任务《评审支付模块重构方案》（id=T-01）：…`
 * 单行输出：对话页的输入框是单行 input，换行会被吃掉，摘要必须压成一行。
 */
export function contextPrompt(ctx: AiContext): string {
  const clean = normalize(ctx)
  if (clean === undefined) return ''
  const label = kindLabel(clean.kind)
  const head = `关于${label}《${clean.title}》（id=${clean.id}）：`
  return clean.excerpt === undefined ? head : `${head}${clean.excerpt}`
}

/** 顶部上下文 chip 的文案：`引用：任务《…》`。 */
export function contextLabel(ctx: AiContext): string {
  const clean = normalize(ctx)
  if (clean === undefined) return ''
  return `引用：${kindLabel(clean.kind)}《${clean.title}》`
}
