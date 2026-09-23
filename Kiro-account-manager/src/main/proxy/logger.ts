// 代理服务器日志模块
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { redactString, redactValue } from '../utils/redact'

export interface LogEntry {
  timestamp: string
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  category: string
  message: string
  data?: unknown
}

export interface LoggerConfig {
  enabled: boolean
  logDir?: string
  maxFileSize?: number // 最大文件大小 (bytes)
  maxFiles?: number // 最大文件数量
  logToConsole?: boolean
}

/** Error 归一化后的形状；stack 截断，cause 递归展开 */
interface NormalizedError {
  name: string
  message: string
  code?: string
  errno?: number
  syscall?: string
  stack?: string
  cause?: unknown
  errors?: unknown[]
}

/** stack 保留行数：足够定位调用点，又不让单条日志膨胀 */
const STACK_LINES = 4

/**
 * 把 Error 转成可 JSON 序列化的纯对象。
 *
 * 必要性：Error 的 message/stack/name 都是非枚举属性，JSON.stringify(new Error('x')) === '{}'。
 * 日志里 console.error('...', error) 直传 Error 时，data 会整条丢成 {}，
 * 网络故障（DNS/TLS/超时）因此完全无法区分。
 *
 * undici 的 `fetch failed` 是包装错误，真实原因（ENOTFOUND / ECONNRESET / UND_ERR_*）
 * 只在 cause 链里，所以必须递归展开——这是本函数的主要价值。
 */
function normalizeError(err: Error, depth = 0): NormalizedError {
  const e = err as Error & { code?: string; errno?: number; syscall?: string; cause?: unknown; errors?: unknown[] }
  const out: NormalizedError = {
    name: e.name || 'Error',
    message: e.message || String(e)
  }
  if (e.code !== undefined) out.code = String(e.code)
  if (typeof e.errno === 'number') out.errno = e.errno
  if (e.syscall !== undefined) out.syscall = String(e.syscall)
  if (typeof e.stack === 'string') {
    out.stack = e.stack.split('\n').slice(0, STACK_LINES).join('\n')
  }
  // cause 链递归展开（限深，防御自引用与超长链）
  if (e.cause !== undefined && e.cause !== null && depth < 4) {
    out.cause = e.cause instanceof Error ? normalizeError(e.cause, depth + 1) : e.cause
  }
  // AggregateError.errors（Node 在多地址连接全部失败时用它聚合）
  if (Array.isArray(e.errors) && depth < 4) {
    out.errors = e.errors.map((sub) => (sub instanceof Error ? normalizeError(sub, depth + 1) : sub))
  }
  return out
}

/**
 * 递归把值里的 Error 实例换成归一化纯对象。
 * 必须在 redactValue 之前调用：归一化后 message/stack 变成普通字符串属性，
 * 才能被脱敏逻辑扫到（否则 token 可能藏在 Error.message 里逃过脱敏）。
 */
export function normalizeErrors(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return normalizeError(value)
  if (value == null || typeof value !== 'object' || depth >= 6) return value
  if (Array.isArray(value)) return value.map((v) => normalizeErrors(v, depth + 1))
  // 只在含 Error 时重建对象，避免给每条日志都多复制一层
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.some(([, v]) => v instanceof Error || (v !== null && typeof v === 'object'))) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries) out[k] = normalizeErrors(v, depth + 1)
  return out
}

const DEFAULT_CONFIG: LoggerConfig = {
  enabled: false,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
  logToConsole: true
}

class ProxyLogger {
  private config: LoggerConfig
  private logStream: fs.WriteStream | null = null
  private currentLogFile: string = ''
  private currentFileSize: number = 0

  constructor() {
    this.config = { ...DEFAULT_CONFIG }
  }

  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config }
    
    if (this.config.enabled && !this.config.logDir) {
      // 默认日志目录
      this.config.logDir = path.join(app.getPath('userData'), 'logs', 'proxy')
    }

    if (this.config.enabled) {
      this.initLogFile()
    } else {
      this.close()
    }
  }

  private initLogFile(): void {
    if (!this.config.logDir) return

    try {
      // 确保目录存在
      fs.mkdirSync(this.config.logDir, { recursive: true })

      // 创建新的日志文件
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      this.currentLogFile = path.join(this.config.logDir, `proxy-${timestamp}.log`)
      this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' })
      this.currentFileSize = 0

      this.info('Logger', 'Log file initialized', { file: this.currentLogFile })
    } catch (error) {
      console.error('[ProxyLogger] Failed to init log file:', error)
    }
  }

  private rotateIfNeeded(): void {
    if (!this.config.maxFileSize || this.currentFileSize < this.config.maxFileSize) {
      return
    }

    this.close()
    this.cleanOldLogs()
    this.initLogFile()
  }

  private cleanOldLogs(): void {
    if (!this.config.logDir || !this.config.maxFiles) return

    try {
      const files = fs.readdirSync(this.config.logDir)
        .filter(f => f.startsWith('proxy-') && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.config.logDir!, f),
          time: fs.statSync(path.join(this.config.logDir!, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time)

      // 删除超出数量限制的旧文件
      while (files.length >= this.config.maxFiles) {
        const oldest = files.pop()
        if (oldest) {
          fs.unlinkSync(oldest.path)
        }
      }
    } catch (error) {
      console.error('[ProxyLogger] Failed to clean old logs:', error)
    }
  }

  private isWriting = false
  private write(rawEntry: LogEntry): void {
    // 统一脱敏：message + data 里的代理账密 / token / password 等，避免明文落盘或上屏
    // Error 先归一化再脱敏，否则 JSON.stringify 会把 Error 整条丢成 {}
    const entry: LogEntry = {
      ...rawEntry,
      message: redactString(rawEntry.message),
      data: rawEntry.data === undefined ? undefined : redactValue(normalizeErrors(rawEntry.data))
    }
    const line = JSON.stringify(entry) + '\n'

    if (this.config.logToConsole) {
      const prefix = `[${entry.level}][${entry.category}]`
      // 设置 flag 防止 console 拦截器重复写入 proxyLogStore
      this.isWriting = true
      if (entry.level === 'ERROR') {
        console.error(prefix, entry.message, entry.data || '')
      } else if (entry.level === 'WARN') {
        console.warn(prefix, entry.message, entry.data || '')
      } else {
        console.log(prefix, entry.message, entry.data || '')
      }
      this.isWriting = false
    }

    if (this.config.enabled && this.logStream) {
      this.logStream.write(line)
      this.currentFileSize += Buffer.byteLength(line)
      this.rotateIfNeeded()
    }

    // 同时添加到内存存储（用于 UI 显示）
    proxyLogStore.add(entry)
  }

  get _isWriting(): boolean { return this.isWriting }

  debug(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'DEBUG',
      category,
      message,
      data
    })
  }

  info(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      category,
      message,
      data
    })
  }

  warn(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      category,
      message,
      data
    })
  }

  error(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      category,
      message,
      data
    })
  }

  // 记录请求
  request(info: {
    path: string
    method: string
    model?: string
    accountId?: string
  }): void {
    this.info('Request', `${info.method} ${info.path}`, info)
  }

  // 记录响应
  response(info: {
    path: string
    status: number
    tokens?: number
    responseTime?: number
    error?: string
  }): void {
    if (info.error) {
      this.error('Response', `${info.path} -> ${info.status}`, info)
    } else {
      this.info('Response', `${info.path} -> ${info.status}`, info)
    }
  }

  // 记录 Token 刷新
  tokenRefresh(accountId: string, success: boolean, error?: string): void {
    if (success) {
      this.info('TokenRefresh', `Account ${accountId} refreshed successfully`)
    } else {
      this.error('TokenRefresh', `Account ${accountId} refresh failed`, { error })
    }
  }

  close(): void {
    if (this.logStream) {
      this.logStream.end()
      this.logStream = null
    }
  }

  getLogDir(): string | undefined {
    return this.config.logDir
  }
}

// 内存日志存储（用于 UI 显示）
//
// 性能修复要点：
// 1. maxLogs 从 100万 降至 5万 — 避免序列化数百 MB 大对象阻塞主进程
// 2. save() 改为异步 fs.promises.writeFile — 不再 freeze 主进程事件循环
// 3. 单次写盘原子化（in-flight guard）防止并发 writeFile 导致竞态
// 4. 写盘节流间隔从 5s 提至 30s — 大幅降低高频日志场景下的 IO 频率
// 5. 应用退出时通过 flushSaveNow() 强制写盘，防止数据丢失
class ProxyLogStore {
  private logs: LogEntry[] = []
  // 5 万条 × 平均 200 字节 ≈ 10 MB；既能覆盖常规调试需求，又把单次写盘成本控制在可接受范围内
  private maxLogs: number = 50000
  private listeners: ((entry: LogEntry) => void)[] = []
  private storePath: string = ''

  private initialized = false
  initialize(userDataPath: string): void {
    if (this.initialized) return
    this.initialized = true
    this.storePath = path.join(userDataPath, 'proxy-logs.json')
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf-8')
        const parsed = JSON.parse(data)
        // 验证并过滤有效的日志条目
        const filtered = Array.isArray(parsed) ? parsed.filter((log: LogEntry) => {
          if (!log.timestamp || isNaN(new Date(log.timestamp).getTime())) return false
          if (!log.level || !log.category) return false
          return true
        }) : []
        // 加载时也施加上限，避免旧版本遗留的超大日志文件导致首次启动卡顿
        this.logs = filtered.length > this.maxLogs ? filtered.slice(-this.maxLogs) : filtered
        console.log(`[ProxyLogStore] Loaded ${this.logs.length} valid logs`)
      }
    } catch (error) {
      console.error('[ProxyLogStore] Failed to load logs:', error)
      this.logs = []
    }
  }

  /** 异步保存日志（不阻塞主进程事件循环）。并发调用通过 in-flight 标志合并。 */
  private writeInFlight = false
  private writePending = false

  async save(): Promise<void> {
    if (this.writeInFlight) {
      // 已有写盘进行中：标记 pending，让其完成后立即重写最新数据
      this.writePending = true
      return
    }
    this.writeInFlight = true
    try {
      // 拷贝引用快照（不复制数组）以保证 JSON.stringify 期间数据稳定
      const snapshot = this.logs
      await fs.promises.writeFile(this.storePath, JSON.stringify(snapshot), 'utf-8')
    } catch (error) {
      console.error('[ProxyLogStore] Failed to save logs:', error)
    } finally {
      this.writeInFlight = false
      if (this.writePending) {
        this.writePending = false
        // 用 microtask 而不是立即递归，避免栈深问题
        queueMicrotask(() => { void this.save() })
      }
    }
  }

  private saveTimer: NodeJS.Timeout | null = null

  add(entry: LogEntry): void {
    this.logs.push(entry)

    // 超过最大数量时删除最旧的
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs)
    }

    // 通知监听器（异常隔离）
    for (const listener of this.listeners) {
      try { listener(entry) } catch { /* ignore */ }
    }

    // 节流调度异步保存
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (this.saveTimer) return  // 已调度，等待 flush
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, 30_000) // 30 秒批量写盘一次（异步、不阻塞）
  }

  /** 强制立即写盘（用于退出场景），保证最新数据落盘 */
  async flushSaveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.save()
  }

  getAll(): LogEntry[] {
    return [...this.logs]
  }

  getLast(count: number): LogEntry[] {
    return this.logs.slice(-count)
  }

  clear(): void {
    this.logs = []
    void this.save()
  }

  count(): number {
    return this.logs.length
  }

  onLog(listener: (entry: LogEntry) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index >= 0) {
        this.listeners.splice(index, 1)
      }
    }
  }
}

export const proxyLogStore = new ProxyLogStore()

// 单例导出
export const proxyLogger = new ProxyLogger()

// 拦截主进程 console 输出，自动转发到 proxyLogStore
// 这样所有 console.log/warn/error 都能在日志页面显示
let consoleIntercepted = false
export function interceptConsole(): void {
  if (consoleIntercepted) return
  consoleIntercepted = true

  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error

  const parseConsoleCategory = (args: unknown[]): { category: string; message: string } => {
    const first = String(args[0] || '')
    // 匹配 [Category] 或 [INFO][Category] 格式
    const bracketMatch = first.match(/^\[(?:DEBUG|INFO|WARN|ERROR)\]?\[?([^\]]*)\]?\s*(.*)/)
    if (bracketMatch) {
      return { category: bracketMatch[1] || 'App', message: bracketMatch[2] || '' }
    }
    const simpleMatch = first.match(/^\[([^\]]+)\]\s*(.*)/)
    if (simpleMatch) {
      return { category: simpleMatch[1], message: simpleMatch[2] || '' }
    }
    return { category: 'App', message: first }
  }

  const buildEntry = (args: unknown[], level: 'INFO' | 'WARN' | 'ERROR'): LogEntry => {
    const { category, message } = parseConsoleCategory(args)
    const rest = args.slice(1)
    // data: 后续参数（对象/数组保留结构，字符串拼接）
    let data: unknown = undefined
    if (rest.length === 1) {
      data = rest[0]
    } else if (rest.length > 1) {
      // 如果全是字符串，拼成一个；否则保持数组
      const allStrings = rest.every(r => typeof r === 'string')
      data = allStrings ? (rest as string[]).join(' ') : rest
    }
    // console.error('[X] msg:', error) 是主进程最常见写法，Error 必须在此归一化，
    // 否则 proxyLogStore.add 直接存原始 Error，落盘 JSON.stringify 后只剩 {}。
    // 这条路径不经过 ProxyLogger.write，脱敏要在此自行施加：归一化把 Error.message
    // 变成可见字符串属性，其中可能含 token（如 "Auth error 403: {...accessToken...}"）。
    return {
      timestamp: new Date().toISOString(),
      level,
      category,
      message: redactString(message),
      data: data === undefined ? undefined : redactValue(normalizeErrors(data))
    }
  }

  console.log = (...args: unknown[]) => {
    originalLog.apply(console, args)
    if (proxyLogger._isWriting) return
    proxyLogStore.add(buildEntry(args, 'INFO'))
  }

  console.warn = (...args: unknown[]) => {
    originalWarn.apply(console, args)
    if (proxyLogger._isWriting) return
    proxyLogStore.add(buildEntry(args, 'WARN'))
  }

  console.error = (...args: unknown[]) => {
    originalError.apply(console, args)
    if (proxyLogger._isWriting) return
    proxyLogStore.add(buildEntry(args, 'ERROR'))
  }
}
