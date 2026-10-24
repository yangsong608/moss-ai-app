/**
 * dsh-genui（`dsh-ui` fence）的解析与最小渲染契约。
 *
 * 插件在 PC 端把 fence 里的 JSON 渲染成可交互组件；手机端只能实现一个子集，
 * 但**必须实现**——否则 agent 输出的结构化内容（表格、指标、步骤）在手机上
 * 就是一坨 JSON。
 *
 * 设计原则（与 genui 一致）：
 *   - 白名单：只认已知 type，未知类型单条丢弃，不拖垮整块
 *   - 不执行任何脚本，只做展示
 *   - 解析失败 → 交给调用方降级成代码块，不丢内容
 */

import { completeFenceJson, repairFenceJson } from './genui-repair'

export interface GenuiNode {
  readonly type: string
  readonly [key: string]: unknown
}

export interface GenuiSpec {
  readonly title?: string
  readonly gap?: number
  readonly items: readonly GenuiNode[]
}

/** 手机端已支持渲染的类型。其余整条跳过（并在末尾提示数量）。 */
export const SUPPORTED = new Set([
  'text',
  'list',
  'table',
  'keyvalue',
  'callout',
  'stat',
  'divider',
  'code',
  'json',
  'steps',
  'badge',
  'chart',
  // 选项式提问：点选后由客户端把选择作为一条消息发回
  'choice',
  // 0.14.0 起常见，手机端给最小实现（不解嵌套布局，只保证内容不丢）
  'progress',
  'arrow',
  'icon',
  'link',
  'copy',
])

/**
 * 布局容器：手机端单列渲染，不做并排/网格，但**子节点必须保住**
 * （0.14.0 后模型大量用 row/col/card 包内容，直接整条丢弃等于整块空白）。
 */
export const CONTAINERS = new Set(['row', 'col', 'grid', 'card', 'hero'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 缺 `type` 的节点按字段推断（对齐 dsh-genui 0.14.0「推断缺少类型的合法组件节点」）。
 * 推断不出来返回 undefined → 计入 skipped。
 */
function inferType(node: Record<string, unknown>): string | undefined {
  if (typeof node['content'] === 'string') return 'text'
  if (typeof node['text'] === 'string') return 'text'
  if (Array.isArray(node['steps'])) return 'steps'
  if (Array.isArray(node['pairs'])) return 'keyvalue'
  if (Array.isArray(node['columns']) && Array.isArray(node['rows'])) return 'table'
  if (Array.isArray(node['options'])) return 'choice'
  if (Array.isArray(node['items'])) return 'row' // 按容器处理，走展平
  return undefined
}

/**
 * 把节点列表展平成单列：容器换行展开（row/col/grid/card/hero），
 * 叶子节点按白名单保留；递归上限防病态嵌套。
 */
function flatten(src: readonly unknown[], depth: number, kept: GenuiNode[], skipped: { n: number }): void {
  if (depth > 6) { skipped.n += src.length; return }
  for (const raw of src) {
    if (!isRecord(raw)) { skipped.n += 1; continue }
    const typed = typeof raw['type'] === 'string' ? raw['type'] : inferType(raw)
    if (typed === undefined) { skipped.n += 1; continue }
    const node = raw as GenuiNode
    if (CONTAINERS.has(typed)) {
      flatten(arr(node, 'items'), depth + 1, kept, skipped)
      continue
    }
    if (!SUPPORTED.has(typed)) { skipped.n += 1; continue }
    // 推断出来的类型补进节点，渲染层不必再判空
    if (typeof raw['type'] !== 'string') { kept.push({ ...node, type: typed }); continue }
    kept.push(node)
  }
}

/**
 * 解析一段 dsh-ui 的 JSON 文本。
 *
 * 返回 `undefined` 表示"这不是我们认得的结构"——调用方据此降级成代码块，
 * 而不是显示一个空壳。
 *
 * 解析分三级（对齐 dsh-genui 端的容错，否则电脑能渲染、手机掉原始 JSON）：
 *   1. 裸 JSON.parse
 *   2. Tier-1 修复（尾逗号、字符串内未转义半角引号）
 *   3. Tier-2 补全（缺失的收尾引号/括号）——流式中可能短暂渲染不完整内容
 */
function parseSpecJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch { /* 继续修复 */ }
  const tier1 = repairFenceJson(raw)
  if (tier1 !== null) {
    try {
      return JSON.parse(tier1.text)
    } catch { /* 继续补全 */ }
  }
  const tier2 = completeFenceJson(raw)
  if (tier2 !== null) {
    try {
      return JSON.parse(tier2.text)
    } catch { /* 放弃 */ }
  }
  return undefined
}

export function parseGenui(raw: string): { spec: GenuiSpec; skipped: number } | undefined {
  const data = parseSpecJson(raw)
  if (!isRecord(data)) return undefined
  const items = Array.isArray(data['items']) ? data['items'] : []
  if (items.length === 0) return undefined

  const kept: GenuiNode[] = []
  const skipped = { n: 0 }
  flatten(items, 0, kept, skipped)

  return {
    spec: {
      ...(typeof data['title'] === 'string' ? { title: data['title'] } : {}),
      ...(typeof data['gap'] === 'number' ? { gap: data['gap'] } : {}),
      items: kept,
    },
    skipped: skipped.n,
  }
}

/** 取字符串字段（模板里不能直接对 unknown 做断言）。 */
export function str(node: GenuiNode, key: string): string {
  const v = node[key]
  return typeof v === 'string' ? v : ''
}

/** 取数字字段。 */
export function num(node: GenuiNode, key: string): number | undefined {
  const v = node[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 取数组字段。 */
export function arr(node: GenuiNode, key: string): readonly unknown[] {
  const v = node[key]
  return Array.isArray(v) ? v : []
}

export interface KeyValuePair { readonly key: string; readonly value: string }
export function pairs(node: GenuiNode): KeyValuePair[] {
  const out: KeyValuePair[] = []
  for (const raw of arr(node, 'pairs')) {
    if (!isRecord(raw)) continue
    out.push({
      key: String(raw['key'] ?? ''),
      value: String(raw['value'] ?? ''),
    })
  }
  return out
}

export interface TableData { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] }
export function table(node: GenuiNode): TableData | undefined {
  const columns = arr(node, 'columns').map((c) => String(c))
  const rawRows = arr(node, 'rows')
  if (columns.length === 0) return undefined
  const rows: string[][] = []
  for (const r of rawRows) {
    if (!Array.isArray(r)) continue
    rows.push(r.map((c) => String(c)))
  }
  return { columns, rows }
}

export interface ChartPoint { readonly label: string; readonly value: number }
export function chartPoints(node: GenuiNode): ChartPoint[] {
  const out: ChartPoint[] = []
  for (const raw of arr(node, 'data')) {
    if (!isRecord(raw)) continue
    const value = typeof raw['value'] === 'number' ? raw['value'] : Number(raw['value'])
    if (!Number.isFinite(value)) continue
    out.push({ label: String(raw['label'] ?? ''), value })
  }
  return out
}

export interface ChoiceOption { readonly label: string; readonly value: string }

/**
 * 选项式提问。
 *
 * 约定：dsh-ui fence 里写
 *   { "type": "choice", "question": "…", "options": ["A", "B"], "multi": false }
 * options 可以是字符串，也可以是 { label, value }。
 *
 * 为什么放在 dsh-ui 而不是新造一个事件：genui 本来就在渲染结构化 UI，
 * 提问本质上就是"一个有按钮的组件"，复用同一条通道最省事。
 */
export function choice(node: GenuiNode): { question: string; options: readonly ChoiceOption[]; multi: boolean } | undefined {
  const question = str(node, 'question') || str(node, 'content')
  const raw = arr(node, 'options')
  if (question.length === 0 || raw.length === 0) return undefined
  const options: ChoiceOption[] = []
  for (const o of raw) {
    if (typeof o === 'string') { options.push({ label: o, value: o }); continue }
    if (typeof o === 'object' && o !== null) {
      const r = o as Record<string, unknown>
      const label = String(r['label'] ?? r['value'] ?? '')
      if (label.length > 0) options.push({ label, value: String(r['value'] ?? label) })
    }
  }
  if (options.length === 0) return undefined
  return { question, options, multi: node['multi'] === true }
}
