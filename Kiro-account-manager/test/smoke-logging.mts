// 冒烟测试：伪造 AWS 上游，验证 v1.7.13 系统日志改造
//   场景 A：两个并发流式请求 → 各自日志带不同 reqId，互不串号；每个请求恰有一条 Request done 汇总
//   场景 B：thinking 流 → 不再逐块记录 reasoning，结束时只有一条汇总
//   场景 C：首个端点 fetch failed → 汇总里 via 记录 failover 路径
// 运行：node_modules/.bin/esbuild test/smoke-logging.mts --bundle --platform=node --format=cjs \
//        --external:electron --outfile=test/.smoke-logging.cjs && node test/.smoke-logging.cjs
import http from 'http'
import { ProxyServer } from '../src/main/proxy/proxyServer'
import {
  proxyLogStore,
  interceptConsole,
  getRequestContext,
  type LogEntry
} from '../src/main/proxy/logger'
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

// 分帧延迟输出，保证两个并发请求的日志在时间上交错
function streamResponse(frames: Uint8Array[], gapMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      for (const f of frames) {
        await new Promise((r) => setTimeout(r, gapMs))
        c.enqueue(f)
      }
      c.close()
    }
  })
  return new Response(body, { status: 200 })
}

const REASONING_CHUNKS = 30

type Script = 'normal' | 'thinking' | 'failover'
let script: Script = 'normal'
let upstreamCalls = 0
const originalFetch = globalThis.fetch

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
  if (!url.includes('amazonaws.com')) {
    return originalFetch(input, init)
  }
  if (init?.method !== 'POST') {
    return new Response('{}', { status: 200 })
  }
  upstreamCalls++
  if (script === 'failover' && upstreamCalls === 1) throw new TypeError('fetch failed')
  if (script === 'thinking') {
    const frames: Uint8Array[] = []
    for (let i = 0; i < REASONING_CHUNKS; i++) {
      frames.push(frame('reasoningContentEvent', { reasoningContentEvent: { text: `思考${i} ` } }))
    }
    frames.push(frame('assistantResponseEvent', { assistantResponseEvent: { content: '答案' } }))
    return streamResponse(frames, 1)
  }
  return streamResponse(
    [
      frame('assistantResponseEvent', { assistantResponseEvent: { content: '你好' } }),
      frame('assistantResponseEvent', { assistantResponseEvent: { content: '，世界' } })
    ],
    40
  )
}) as typeof fetch

const account: ProxyAccount = {
  id: 'smoke-account-1',
  email: 'smoke@test.local',
  accessToken: 'fake-token',
  provider: 'BuilderId',
  authMethod: 'idc',
  region: 'us-east-1',
  expiresAt: Date.now() + 3600_000
}

async function main(): Promise<void> {
  interceptConsole()
  const logs: LogEntry[] = []
  proxyLogStore.onLog((e) => logs.push(e))
  const responseReqIds: Array<{ model?: string; reqId?: string }> = []

  const server = new ProxyServer(
    {
      enabled: true,
      port: 0,
      host: '127.0.0.1',
      enableMultiAccount: true,
      maxRetries: 3,
      retryDelayMs: 30,
      sessionAffinityEnabled: false,
      logRequests: true
    },
    {
      onPoolEmpty: async () => {
        server.getAccountPool().addAccount(account)
      },
      // 主进程用它把 reqId 附到「请求日志」上，必须在请求上下文内触发
      onResponse: (info) => {
        responseReqIds.push({ model: info.model, reqId: getRequestContext()?.reqId })
      }
    }
  )
  await server.start()
  const port = (server as unknown as { server?: { address(): { port: number } } }).server!.address()
    .port
  const base = `http://127.0.0.1:${port}`
  console.log(`[smoke] proxy listening on ${base}`)

  function post(body: unknown): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${base}/v1/messages`,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
          )
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
  }
  const body = (model: string): unknown => ({
    model,
    max_tokens: 128,
    stream: true,
    messages: [{ role: 'user', content: '打个招呼' }]
  })
  // 汇总在请求处理链路的 finally 里输出，晚于响应结束，稍等一拍再断言
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50))

  let failures = 0
  function check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
      console.log(`  ✓ ${name}`)
    } else {
      failures++
      console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }
  const summaries = (from: number): LogEntry[] =>
    logs.slice(from).filter((l) => l.message.startsWith('Request done:'))

  {
    console.log('[smoke] 场景 A：两个并发流式请求')
    script = 'normal'
    upstreamCalls = 0
    const from = logs.length
    const [r1, r2] = await Promise.all([
      post(body('CLAUDE_OPUS_5_TEST')),
      post(body('CLAUDE_SONNET_5_TEST'))
    ])
    await settle()
    check(
      '两个请求均 HTTP 200',
      r1.status === 200 && r2.status === 200,
      `${r1.status}/${r2.status}`
    )
    const done = summaries(from)
    check('恰好 2 条 Request done 汇总', done.length === 2, `got ${done.length}`)
    const ids = new Set(done.map((l) => l.reqId))
    check(
      '两条汇总 reqId 不同且非空',
      ids.size === 2 && !ids.has(undefined),
      JSON.stringify([...ids])
    )
    for (const d of done) {
      const own = logs.slice(from).filter((l) => l.reqId === d.reqId)
      const model = (d.data as { model?: string })?.model
      const upstream = own.filter((l) => l.message.startsWith('Request to '))
      check(
        `#${d.reqId} 上游请求日志只有 1 条且归属正确`,
        upstream.length === 1,
        `got ${upstream.length}`
      )
      const leaked = own.filter(
        (l) => l.message.startsWith('Claude API:') && !l.message.includes(model ?? '?')
      )
      check(
        `#${d.reqId} 未串入另一个请求的日志`,
        leaked.length === 0,
        leaked.map((l) => l.message).join(' | ')
      )
      check(
        `#${d.reqId} 汇总含 total/local/ttfb`,
        /total=\d+ms local=\d+ms ttfb=\d+ms/.test(d.message),
        d.message
      )
    }
    const oldDetail = logs
      .slice(from)
      .filter((l) => /^\s*- (Content length|Payload size)/.test(l.message))
    check('不再有逐行的请求详情日志', oldDetail.length === 0, `got ${oldDetail.length}`)
    const responseIds = new Set(responseReqIds.map((r) => r.reqId))
    check(
      'onResponse 回调能取到与汇总一致的 reqId',
      responseReqIds.length === 2 && [...ids].every((id) => responseIds.has(id)),
      JSON.stringify(responseReqIds)
    )
  }

  {
    console.log('[smoke] 场景 B：thinking 流')
    script = 'thinking'
    upstreamCalls = 0
    const from = logs.length
    const r = await post(body('CLAUDE_OPUS_5_TEST'))
    await settle()
    check('HTTP 200', r.status === 200, `status=${r.status}`)
    const perChunk = logs
      .slice(from)
      .filter(
        (l) =>
          l.message === 'reasoningContentEvent' ||
          l.message.startsWith('Received reasoning content')
      )
    check('无逐块 reasoning 日志', perChunk.length === 0, `got ${perChunk.length}`)
    const sum = logs.slice(from).filter((l) => l.message.startsWith('Reasoning content received:'))
    check(
      `恰好 1 条 reasoning 汇总且块数为 ${REASONING_CHUNKS}`,
      sum.length === 1 && sum[0].message.includes(`${REASONING_CHUNKS} chunks`),
      sum.map((l) => l.message).join(' | ')
    )
  }

  {
    console.log('[smoke] 场景 C：首个端点 fetch failed 后 failover')
    script = 'failover'
    upstreamCalls = 0
    const from = logs.length
    const r = await post(body('CLAUDE_OPUS_5_TEST'))
    await settle()
    check('HTTP 200', r.status === 200, `status=${r.status}`)
    const done = summaries(from)
    const endpoints = (done[0]?.data as { endpoints?: string[] })?.endpoints ?? []
    check(
      '汇总记录了 2 个端点（发生过 failover）',
      done.length === 1 && endpoints.length === 2,
      done[0]?.message
    )
    const errs = logs.slice(from).filter((l) => l.level === 'ERROR')
    check(
      '端点失败 ERROR 日志带同一 reqId',
      errs.length > 0 && errs.every((l) => l.reqId === done[0]?.reqId)
    )
  }

  await server.stop()
  console.log(failures === 0 ? '[smoke] 全部通过 ✓' : `[smoke] ${failures} 项失败 ✗`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('[smoke] 运行异常:', e)
  process.exit(1)
})
