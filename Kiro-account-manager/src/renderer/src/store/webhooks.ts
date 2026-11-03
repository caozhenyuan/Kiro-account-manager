import { create } from 'zustand'

/**
 * Webhook 通知中心
 *
 * 用于把关键事件（批量完成、风控触发、单账号注册成功/失败等）推送到外部 IM。
 * 内置常见 IM 的消息模板：钉钉 / 企微 / Telegram / Discord / 自定义 JSON。
 */

export type WebhookKind = 'dingtalk' | 'wechat-work' | 'telegram' | 'discord' | 'feishu' | 'custom'

export interface WebhookEntry {
  id: string
  kind: WebhookKind
  url: string
  label?: string
  enabled: boolean
  /** Telegram bot 模式需要 chat_id */
  telegramChatId?: string
  /** 自定义模式的 JSON 模板，{{title}} {{message}} {{level}} 占位符 */
  customTemplate?: string
  /** 订阅哪些事件 */
  events: WebhookEvent[]
  createdAt: number
}

export type WebhookEvent =
  | 'batch-completed'      // 批量任务完成
  | 'batch-error'          // 批量任务严重错误
  | 'risk-warning'         // 风控警告触发
  | 'account-banned'       // 账号被封禁
  | 'register-success'     // 单账号注册成功
  | 'register-failed'      // 单账号注册失败
  | 'token-expired'        // Token 过期/刷新失败
  | 'region-quota-reminder' // 当前额度区域已用达到提醒值，需开通下一个区域

export const ALL_WEBHOOK_EVENTS: { value: WebhookEvent; label: string; labelEn: string }[] = [
  { value: 'batch-completed', label: '批量任务完成', labelEn: 'Batch completed' },
  { value: 'batch-error', label: '批量任务严重错误', labelEn: 'Batch error' },
  { value: 'risk-warning', label: '风控警告触发', labelEn: 'Risk warning' },
  { value: 'account-banned', label: '账号被封禁', labelEn: 'Account banned' },
  { value: 'register-success', label: '注册成功（单账号）', labelEn: 'Register success' },
  { value: 'register-failed', label: '注册失败（单账号）', labelEn: 'Register failed' },
  { value: 'token-expired', label: 'Token 过期/刷新失败', labelEn: 'Token expired' },
  { value: 'region-quota-reminder', label: '额度区域待开通', labelEn: 'Open next quota region' }
]

export interface WebhookMessage {
  title: string
  message: string
  level: 'info' | 'warn' | 'error' | 'success'
  /** 可选的额外字段（追加到 message 后） */
  fields?: Record<string, string | number>
}

interface WebhooksState {
  webhooks: Map<string, WebhookEntry>
}

interface WebhooksActions {
  addWebhook: (input: Omit<WebhookEntry, 'id' | 'createdAt'>) => string
  updateWebhook: (id: string, updates: Partial<WebhookEntry>) => void
  removeWebhook: (id: string) => void
  toggleWebhook: (id: string) => void
  /** 触发某个事件：自动给所有订阅了该事件的启用 webhook 发推送 */
  triggerEvent: (event: WebhookEvent, payload: WebhookMessage) => Promise<void>
  /** 测试单个 webhook（发一条测试消息） */
  testWebhook: (id: string) => Promise<{ success: boolean; error?: string }>
  /** 持久化加载（在 store 初始化时调用） */
  loadFromStorage: () => void
  saveToStorage: () => void
}

type WebhooksStore = WebhooksState & WebhooksActions

const STORAGE_KEY = 'kiro-webhooks'

export const useWebhookStore = create<WebhooksStore>()((set, get) => ({
  webhooks: new Map(),

  addWebhook: (input) => {
    const id = crypto.randomUUID()
    const entry: WebhookEntry = {
      ...input,
      id,
      createdAt: Date.now()
    }
    set((state) => {
      const next = new Map(state.webhooks)
      next.set(id, entry)
      return { webhooks: next }
    })
    get().saveToStorage()
    return id
  },

  updateWebhook: (id, updates) => {
    set((state) => {
      const next = new Map(state.webhooks)
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, ...updates })
      return { webhooks: next }
    })
    get().saveToStorage()
  },

  removeWebhook: (id) => {
    set((state) => {
      const next = new Map(state.webhooks)
      next.delete(id)
      return { webhooks: next }
    })
    get().saveToStorage()
  },

  toggleWebhook: (id) => {
    set((state) => {
      const next = new Map(state.webhooks)
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, enabled: !existing.enabled })
      return { webhooks: next }
    })
    get().saveToStorage()
  },

  triggerEvent: async (event, payload) => {
    const webhooks = Array.from(get().webhooks.values())
      .filter((w) => w.enabled && w.events.includes(event))
    if (webhooks.length === 0) return
    await Promise.allSettled(webhooks.map((w) => sendWebhook(w, payload)))
  },

  testWebhook: async (id) => {
    const webhook = get().webhooks.get(id)
    if (!webhook) return { success: false, error: 'Webhook 不存在' }
    try {
      const result = await sendWebhook(
        webhook,
        {
          title: '🧪 测试通知',
          message: '这是来自 Kiro 账号管理器的测试消息。如果你看到这条消息，说明 Webhook 配置正确。',
          level: 'info',
          fields: { 时间: new Date().toLocaleString('zh-CN') }
        },
        { retries: 0 }
      )
      return result.ok ? { success: true } : { success: false, error: result.error }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  loadFromStorage: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const arr = JSON.parse(raw) as WebhookEntry[]
      if (!Array.isArray(arr)) return
      const map = new Map<string, WebhookEntry>()
      for (const w of arr) map.set(w.id, w)
      set({ webhooks: map })
    } catch (err) {
      console.warn('[Webhook] Load failed:', err)
    }
  },

  saveToStorage: () => {
    try {
      const arr = Array.from(get().webhooks.values())
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr))
    } catch (err) {
      console.warn('[Webhook] Save failed:', err)
    }
  }
}))

// ==================== Webhook 发送实现 ====================

/** C9: 每个 webhook 的最近发送时间戳队列（用于本地速率限制） */
const sendTimestamps = new Map<string, number[]>()
const MAX_PER_MINUTE = 20  // 每个 webhook 最多每分钟 20 条
const RETRY_COUNT = 3
const RETRY_DELAY_BASE_MS = 1500  // 指数退避基数

/**
 * 检查并记录速率：超过阈值时返回 false，调用方应跳过本次发送
 */
function checkAndRecordRate(webhookId: string): boolean {
  const now = Date.now()
  const arr = sendTimestamps.get(webhookId) || []
  // 清理 1 分钟外
  const filtered = arr.filter((t) => now - t < 60_000)
  if (filtered.length >= MAX_PER_MINUTE) {
    sendTimestamps.set(webhookId, filtered)
    return false
  }
  filtered.push(now)
  sendTimestamps.set(webhookId, filtered)
  return true
}

/**
 * 按 webhook 类型构造消息体并 POST（含重试 + 速率限制）
 * 网络错误不会抛到调用方（仅 console.warn），避免影响主业务流程
 */
type SendResult = { ok: true } | { ok: false; error: string }

async function sendWebhook(
  webhook: WebhookEntry,
  payload: WebhookMessage,
  options?: { retries?: number }
): Promise<SendResult> {
  const retryCount = options?.retries ?? RETRY_COUNT
  // C9: 速率限制
  if (!checkAndRecordRate(webhook.id)) {
    console.warn(`[Webhook] ${webhook.kind} ${webhook.label || webhook.id} rate limit exceeded (>${MAX_PER_MINUTE}/min), drop`)
    return { ok: false, error: `发送过于频繁（超过 ${MAX_PER_MINUTE} 条/分钟），已丢弃` }
  }

  const body = buildWebhookBody(webhook, payload)
  const url = webhook.kind === 'telegram'
    ? buildTelegramUrl(webhook)
    : webhook.url

  // C9: 重试逻辑（指数退避）
  let lastError: unknown
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAY_BASE_MS * Math.pow(2, attempt - 1)
      await new Promise((resolve) => setTimeout(resolve, delay))
      console.log(`[Webhook] Retry ${attempt}/${retryCount} for ${webhook.kind} ${webhook.label || webhook.id}`)
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      clearTimeout(timer)
      if (resp.ok) {
        if (attempt > 0) {
          console.log(`[Webhook] ${webhook.kind} ${webhook.label || webhook.id} succeeded on retry ${attempt}`)
        }
        return { ok: true }
      }
      // 4xx 客户端错误（除 408/429）不重试
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
        console.warn(`[Webhook] ${webhook.kind} ${webhook.label || webhook.id} HTTP ${resp.status} (no retry)`)
        return { ok: false, error: `HTTP ${resp.status}` }
      }
      lastError = new Error(`HTTP ${resp.status}`)
    } catch (err) {
      lastError = err
    }
  }
  console.warn(`[Webhook] ${webhook.kind} ${webhook.label || webhook.id} failed after ${retryCount} retries:`, lastError)
  return { ok: false, error: lastError instanceof Error ? lastError.message : String(lastError) }
}

function buildTelegramUrl(webhook: WebhookEntry): string {
  // Telegram 的 URL 直接是 https://api.telegram.org/bot<token>/sendMessage
  return webhook.url.endsWith('/sendMessage') ? webhook.url : `${webhook.url.replace(/\/$/, '')}/sendMessage`
}

function buildWebhookBody(webhook: WebhookEntry, payload: WebhookMessage): unknown {
  const icon = ({ info: 'ℹ️', warn: '⚠️', error: '❌', success: '✅' } as const)[payload.level]
  const fieldsText = payload.fields
    ? '\n' + Object.entries(payload.fields).map(([k, v]) => `**${k}**: ${v}`).join('\n')
    : ''
  const plainFields = payload.fields
    ? '\n' + Object.entries(payload.fields).map(([k, v]) => `${k}: ${v}`).join('\n')
    : ''
  const fullText = `${icon} ${payload.title}\n\n${payload.message}${plainFields}`

  switch (webhook.kind) {
    case 'dingtalk':
      // 钉钉机器人 markdown
      return {
        msgtype: 'markdown',
        markdown: {
          title: payload.title,
          text: `### ${icon} ${payload.title}\n\n${payload.message}${fieldsText}`
        }
      }
    case 'wechat-work':
      // 企业微信机器人 markdown
      return {
        msgtype: 'markdown',
        markdown: {
          content: `## ${icon} ${payload.title}\n\n${payload.message}${fieldsText}`
        }
      }
    case 'feishu':
      // 飞书机器人 text
      return {
        msg_type: 'text',
        content: { text: fullText }
      }
    case 'telegram':
      return {
        chat_id: webhook.telegramChatId,
        text: fullText,
        parse_mode: 'Markdown'
      }
    case 'discord':
      // Discord webhook
      return {
        username: 'Kiro Account Manager',
        embeds: [{
          title: `${icon} ${payload.title}`,
          description: payload.message,
          color: payload.level === 'error' ? 0xff0000
            : payload.level === 'warn' ? 0xffaa00
            : payload.level === 'success' ? 0x00ff00
            : 0x4a9eff,
          fields: payload.fields
            ? Object.entries(payload.fields).map(([name, value]) => ({ name, value: String(value), inline: true }))
            : undefined,
          timestamp: new Date().toISOString()
        }]
      }
    case 'custom':
    default: {
      if (webhook.customTemplate) {
        // 简易模板替换
        try {
          const tpl = webhook.customTemplate
            .replace(/\{\{title\}\}/g, escapeJsonString(payload.title))
            .replace(/\{\{message\}\}/g, escapeJsonString(payload.message))
            .replace(/\{\{level\}\}/g, payload.level)
            .replace(/\{\{icon\}\}/g, icon)
          return JSON.parse(tpl)
        } catch {
          // 模板解析失败：退回简单 JSON
        }
      }
      return {
        title: payload.title,
        message: payload.message,
        level: payload.level,
        fields: payload.fields,
        timestamp: new Date().toISOString()
      }
    }
  }
}

function escapeJsonString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
}
