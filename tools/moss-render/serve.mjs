import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// 产物目录相对脚本定位（迁移后不再写死机器路径）
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../dist/build/h5')
// 手机验证时用 HOST=0.0.0.0 node serve.mjs 起局域网服务；默认仅本机
const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? '5188')
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2' }
const server = createServer(async (req, res) => {
  let u = decodeURIComponent((req.url ?? '/').split('?')[0])
  if (u === '/') u = '/index.html'
  // 防路径穿越：规范化后必须仍落在 ROOT 内
  const p = normalize(join(ROOT, u))
  if (!p.startsWith(ROOT + sep)) { res.writeHead(403); res.end('forbidden'); return }
  try {
    const b = await readFile(p)
    res.writeHead(200, { 'content-type': MIME[extname(u)] ?? 'application/octet-stream' })
    res.end(b)
  } catch { res.writeHead(404); res.end('nf') }
})
server.listen(PORT, HOST, () => console.log(`H5 on http://${HOST}:${PORT}`))
