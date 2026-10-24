/**
 * 同步端到端联调脚本（P1 验收工具）
 *
 * 用途：宿主加载带 /sync/* 的工作台插件后，一条命令验证「增量协议 + 网关」全链路。
 *   node scripts/e2e-sync.mjs [--write]
 *
 * 默认只读（meta / delta），--write 会额外做一次 push→delta 往返验证。
 * 连接地址优先 HOST，其次取 DSH_WEB_PORT / 常见端口探测。
 */
const CANDIDATES = [
  process.env.HOST,
  process.env.DSH_URL,
  process.env.DSH_WEB_PORT ? `http://127.0.0.1:${process.env.DSH_WEB_PORT}` : undefined,
  'http://127.0.0.1:63174',
].filter((x) => typeof x === 'string' && x.length > 0)

const WRITE = process.argv.includes('--write')

async function get(base, path, init) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: ctrl.signal })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 保留原文 */ }
    return { status: res.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

function log(ok, label, extra = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
  if (!ok) failed += 1
}

let failed = 0
let base = ''

for (const candidate of CANDIDATES) {
  try {
    const r = await get(candidate, '/workbench-api/health')
    if (r.status >= 200 && r.status < 500) {
      base = candidate
      break
    }
  } catch { /* 试下一个 */ }
}

if (base === '') {
  console.error('未找到可达的 DSH 宿主（试过：' + CANDIDATES.join(', ') + '）')
  process.exit(1)
}
console.log(`e2e-sync · 宿主 ${base}${WRITE ? ' · 写入模式' : ' · 只读模式'}\n`)

const health = await get(base, '/workbench-api/health')
log(health.status === 200, 'GET /workbench-api/health', `HTTP ${health.status}`)

const meta = await get(base, '/workbench-api/sync/meta')
if (meta.status === 404) {
  log(false, 'GET /sync/meta', '404 —— 运行中的宿主还没加载 P1-1（需重启 DSH 或重载 workbench 插件）')
  console.log('\n结论：代码已就绪，等待宿主重载。重启后再跑本脚本即可完成验收。')
  process.exit(1)
}
log(meta.status === 200 && meta.json !== null, 'GET /sync/meta', `HTTP ${meta.status}`)
if (meta.json !== null && typeof meta.json === 'object') {
  const entities = Object.keys(meta.json.entities ?? {})
  log(entities.length > 0, 'meta 返回实体清单', entities.join(', '))
}

const delta = await get(base, '/workbench-api/sync/delta?since=0&limit=50')
log(delta.status === 200, 'GET /sync/delta?since=0', `HTTP ${delta.status}`)
const changes = Array.isArray(delta.json?.changes) ? delta.json.changes : []
const cursor = typeof delta.json?.cursor === 'string' ? delta.json.cursor : ''
log(Array.isArray(delta.json?.changes), 'delta 返回 changes[]', `${changes.length} 条`)
log(cursor.length > 0, 'delta 返回 cursor', cursor === '' ? '' : cursor)

if (cursor.length > 0) {
  const again = await get(base, `/workbench-api/sync/delta?since=${encodeURIComponent(cursor)}&limit=50`)
  const againChanges = Array.isArray(again.json?.changes) ? again.json.changes : []
  log(again.status === 200 && againChanges.length === 0, '游标前进后无重复变更', `${againChanges.length} 条`)
}

if (WRITE) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const probeId = `e2e-${Date.now().toString(36)}`
  const pushed = await get(base, '/workbench-api/sync/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      changes: [{ entity: 'tasks', id: probeId, op: 'upsert', updatedAt: stamp,
        row: { id: probeId, title: 'e2e 探针任务', status: 'next', priority: 'normal', date: '', tags: [] } }],
    }),
  })
  log(pushed.status === 200, 'POST /sync/push（写入探针任务）', `HTTP ${pushed.status}`)
  const accepted = Array.isArray(pushed.json?.accepted) ? pushed.json.accepted : []
  log(accepted.includes(probeId), 'push 返回 accepted 含探针 id', accepted.join(','))

  const after = await get(base, `/workbench-api/sync/delta?since=${encodeURIComponent(cursor)}&limit=50`)
  const hit = (Array.isArray(after.json?.changes) ? after.json.changes : []).some((c) => c.id === probeId)
  log(hit, 'delta 能拉到刚推的探针任务')

  const del = await get(base, '/workbench-api/sync/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changes: [{ entity: 'tasks', id: probeId, op: 'delete', updatedAt: stamp }] }),
  })
  log(del.status === 200, 'POST /sync/push（删除探针任务）', `HTTP ${del.status}`)
}

console.log(failed === 0 ? `\n✅ 端到端同步链路通过（${WRITE ? '含写入' : '只读'}）` : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
