// 冒烟测试：伪造 AWS 上游，验证 v1.7.10 反代修复
//   场景 A：上游先「fetch failed」再「500 高负载(MODEL_TEMPORARILY_UNAVAILABLE)」→ 流式请求应透明重试后成功
//   场景 B：上游持续 500 → 客户端应收到真实 HTTP 500 JSON 错误（而非 200 + SSE error 事件）
//   场景 C：非流式请求遇「fetch failed」→ callWithRetry 应重试后成功
// 运行：node_modules/.bin/esbuild test/smoke-retry.mts --bundle --platform=node --format=cjs \
//        --external:electron --outfile=test/.smoke-retry.cjs && node test/.smoke-retry.cjs
import http from 'http'
import { ProxyServer } from '../src/main/proxy/proxyServer'
import type { ProxyAccount } from '../src/main/proxy/types'

const enc = new TextEncoder()

// 构造 AWS event-stream 帧（解析器不校验 CRC，CRC 填 0 即可）
function frame(eventType: string, payload: Record<string, unknown>): Uint8Array {
  const name = enc.encode(':event-type')
  const value = enc.encode(eventType)
  const payloadBytes = enc.encode(JSON.stringify(payload))
  const header = new Uint8Array(1 + name.length + 1 + 2 + value.length)
  header[0] = name.length
  header.set(name, 1)
  header[1 + name.length] = 7 // string value
  const hv = 1 + name.length + 1
  header[hv] = value.length >> 8
  header[hv + 1] = value.length & 0xff
  header.set(value, hv + 2)
  const total = 12 + header.length + payloadBytes.length + 4
  const buf = new Uint8Array(total)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, total, false)
  dv.setUint32(4, header.length, false)
  buf.set(header, 12)
  buf.set(payloadBytes, 12 + header.length)
  return buf
}

function successResponse(): Response {
  const frames = [
    frame('assistantResponseEvent', { assistantResponseEvent: { content: '你好' } }),
    frame('assistantResponseEvent', { assistantResponseEvent: { content: '，世界' } })
  ]
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(f)
      c.close()
    }
  })
  return new Response(body, { status: 200 })
}

// ===== 伪造上游脚本 =====
type Script = 'A' | 'B' | 'C'
let script: Script = 'A'
let upstreamCalls = 0
const originalFetch = globalThis.fetch

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? '')
  if (!url.includes('amazonaws.com')) {
    return originalFetch(input, init)
  }
  upstreamCalls++
  const callNo = upstreamCalls
  if (init?.method !== 'POST') {
    return new Response('{}', { status: 200 })
  }
  if (script === 'A') {
    if (callNo === 1) throw new TypeError('fetch failed') // 问题清单 #1-#7
    if (callNo === 2) {
      // 问题清单 #8：500 高负载
      return new Response(
        JSON.stringify({
          message: 'Encountered unexpectedly high load when processing the request, please try again.',
          reason: 'MODEL_TEMPORARILY_UNAVAILABLE'
        }),
        { status: 500 }
      )
    }
    return successResponse()
  }
  if (script === 'B') {
    if (callNo <= 6) {
      return new Response(
        JSON.stringify({
          message: 'Encountered unexpectedly high load when processing the request, please try again.',
          reason: 'MODEL_TEMPORARILY_UNAVAILABLE'
        }),
        { status: 500 }
      )
    }
    return successResponse()
  }
  // C：非流式，第一次 fetch failed，后续成功
  if (callNo === 1) throw new TypeError('fetch failed')
  return successResponse()
}) as typeof fetch

// ===== 启动 ProxyServer =====
const account: ProxyAccount = {
  id: 'smoke-account-1',
  email: 'smoke@test.local',
  accessToken: 'fake-token',
  provider: 'BuilderId',
  authMethod: 'idc',
  region: 'us-east-1',
  expiresAt: Date.now() + 3600_000
}

async function main() {

const server = new ProxyServer(
  {
    enabled: true,
    port: 0,
    host: '127.0.0.1',
    enableMultiAccount: true,
    maxRetries: 3,
    retryDelayMs: 30,
    sessionAffinityEnabled: false,
    logRequests: false
  },
  {
    onPoolEmpty: async () => {
      server.getAccountPool().addAccount(account)
    }
  }
)
await server.start()
const port = (server as any).server?.address?.().port as number
const base = `http://127.0.0.1:${port}`
console.log(`[smoke] proxy listening on ${base}`)

function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 场景 A：流式 + fetch failed + 500 高负载 → 透明重试成功
{
  console.log('[smoke] 场景 A：流式请求，上游先 fetch failed 再 500 高负载')
  script = 'A'
  upstreamCalls = 0
  const r = await post('/v1/messages', {
    model: 'CLAUDE_OPUS_5_TEST',
    max_tokens: 128,
    stream: true,
    messages: [{ role: 'user', content: '打个招呼' }]
  })
  check('HTTP 200', r.status === 200, `status=${r.status}`)
  check('SSE 头', r.text.includes('text/event-stream') || r.text.includes('message_start'), r.text.slice(0, 200))
  check('内容完整（透明重试生效）', r.text.includes('你好') && r.text.includes('，世界'), r.text.slice(0, 400))
  check('正常收尾 message_stop', r.text.includes('message_stop'))
  check('无 SSE error 事件', !r.text.includes('event: error'))
  check('上游被调 3 次（2 次失败 + 1 次成功）', upstreamCalls === 3, `upstreamCalls=${upstreamCalls}`)
}

// 场景 B：持续 500 → 真实 HTTP 500（而非 200 + SSE error）
{
  console.log('[smoke] 场景 B：流式请求，上游持续 500 高负载')
  script = 'B'
  upstreamCalls = 0
  const r = await post('/v1/messages', {
    model: 'CLAUDE_OPUS_5_TEST',
    max_tokens: 128,
    stream: true,
    messages: [{ role: 'user', content: '打个招呼' }]
  })
  check('HTTP 500（真实状态码，非 200）', r.status === 500, `status=${r.status}`)
  check('JSON 错误体（Anthropic 格式）', r.text.includes('"type":"error"') && r.text.includes('api_error'), r.text.slice(0, 300))
  check('重试耗尽（3 次请求级尝试 = 6 次上游调用）', upstreamCalls === 6, `upstreamCalls=${upstreamCalls}`)
}

// 场景 C：非流式 + fetch failed → callWithRetry 重试成功
{
  console.log('[smoke] 场景 C：非流式请求，上游 fetch failed')
  script = 'C'
  upstreamCalls = 0
  const r = await post('/v1/messages', {
    model: 'CLAUDE_OPUS_5_TEST',
    max_tokens: 128,
    stream: false,
    messages: [{ role: 'user', content: '打个招呼' }]
  })
  check('HTTP 200', r.status === 200, `status=${r.status} body=${r.text.slice(0, 200)}`)
  check('内容完整', r.text.includes('你好'), r.text.slice(0, 300))
  check('上游被调 2 次（1 失败 + 1 成功）', upstreamCalls === 2, `upstreamCalls=${upstreamCalls}`)
}

await server.stop()
console.log(failures === 0 ? '[smoke] 全部通过 ✓' : `[smoke] ${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('[smoke] 运行异常:', e)
  process.exit(1)
})
