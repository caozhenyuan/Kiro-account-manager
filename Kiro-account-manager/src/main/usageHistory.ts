// 用量历史快照：按天记录各账号（按额度区域区分）的 usage.current / limit，供首页「月度额度分析」画每日趋势。
// 独立文件存放，不进账号数据：账号库每次写盘都要整库加解密，历史会随天数增长。
import { promises as fs } from 'fs'
import { join } from 'path'

/** 保留天数 */
export const HISTORY_RETENTION_DAYS = 90

export interface AccountDaySnapshot {
  /** usage.current：当前周期已用 */
  c: number
  /** usage.limit */
  l: number
  /** 订阅名称（优先 title，如 KIRO PRO+），用于按类型汇总 */
  t?: string
  /** 该额度的下次重置时间（ISO），重置前后用量会清零，趋势差值据此判断 */
  r?: string
  /** 额度区域 */
  g?: string
}

/** 日期（本地时区 YYYY-MM-DD）→ 序列键 `${账号ID}|${额度区域}` → 当天最后一次快照 */
export type UsageHistory = Record<string, Record<string, AccountDaySnapshot>>

interface AccountLike {
  status?: string
  usage?: { current?: number; limit?: number; nextResetDate?: string }
  subscription?: { type?: string; title?: string }
  credentials?: { region?: string; apiRegion?: string }
}

/**
 * 同一账号可在不同额度区域各有一份独立额度（各自的订阅、用量、重置周期），
 * 所以按「账号 + 额度区域」分序列记录，趋势差值才不会跨区域相减。
 * 键格式与渲染端 lib/usageAnalytics.ts 的 snapshotKey 保持一致。
 */
export function snapshotKey(id: string, region: string): string {
  return `${id}|${region}`
}

/** 与反代 getApiRegion 同口径：apiRegion → region → us-east-1 */
export function apiRegionOf(acc: AccountLike): string {
  return acc.credentials?.apiRegion || acc.credentials?.region || 'us-east-1'
}

export function dayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 从账号数据取出需要记录的快照；只记正常账号，额度未知（limit<=0）的跳过 */
export function extractSnapshots(data: unknown): Record<string, AccountDaySnapshot> {
  const accounts = (data as { accounts?: Record<string, AccountLike> } | null)?.accounts
  const out: Record<string, AccountDaySnapshot> = {}
  if (!accounts || typeof accounts !== 'object') return out
  for (const [id, acc] of Object.entries(accounts)) {
    if (!acc || acc.status !== 'active') continue
    const limit = Number(acc.usage?.limit)
    const current = Number(acc.usage?.current)
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(current)) continue
    const region = apiRegionOf(acc)
    const snap: AccountDaySnapshot = { c: round2(current), l: round2(limit), g: region }
    const plan = acc.subscription?.title || acc.subscription?.type
    if (plan) snap.t = plan
    if (acc.usage?.nextResetDate) snap.r = acc.usage.nextResetDate
    out[snapshotKey(id, region)] = snap
  }
  return out
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 把当天快照合并进历史（同一天后写覆盖先写），并裁掉超过保留期的旧数据 */
export function mergeSnapshots(
  history: UsageHistory,
  snapshots: Record<string, AccountDaySnapshot>,
  now: Date
): UsageHistory {
  const today = dayKey(now)
  const next: UsageHistory = { ...history }
  if (Object.keys(snapshots).length > 0) {
    next[today] = { ...(history[today] ?? {}), ...snapshots }
  }
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - HISTORY_RETENTION_DAYS)
  const cutoffKey = dayKey(cutoff)
  for (const key of Object.keys(next)) {
    if (key < cutoffKey) delete next[key]
  }
  return next
}

/** 历史存储：内存缓存 + 节流异步写盘 */
export class UsageHistoryStore {
  private history: UsageHistory = {}
  private loaded = false
  private timer: NodeJS.Timeout | null = null
  private writing = false
  private pending = false
  /** 内存里有尚未写盘的改动；退出时的 flush 据此决定是否落盘，避免凭空写出空文件 */
  private dirty = false

  constructor(
    private readonly dir: string,
    private readonly fileName = 'usage-history.json'
  ) {}

  private get path(): string {
    return join(this.dir, this.fileName)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await fs.readFile(this.path, 'utf-8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.history = parsed as UsageHistory
      }
    } catch {
      // 文件不存在或损坏：从空历史开始
    }
  }

  /** 记录一次账号数据落盘时的用量；写盘节流 30 秒 */
  async record(data: unknown, now = new Date()): Promise<void> {
    await this.load()
    const snapshots = extractSnapshots(data)
    if (Object.keys(snapshots).length === 0) return
    this.history = mergeSnapshots(this.history, snapshots, now)
    this.dirty = true
    this.scheduleSave()
  }

  async get(): Promise<UsageHistory> {
    await this.load()
    return this.history
  }

  private scheduleSave(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.save()
    }, 30_000)
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.save()
  }

  private async save(): Promise<void> {
    if (!this.loaded || !this.dirty) return
    if (this.writing) {
      this.pending = true
      return
    }
    this.writing = true
    // 写盘期间又有新记录会重新置位，由 finally 里的 pending 补写
    this.dirty = false
    try {
      await fs.mkdir(this.dir, { recursive: true })
      // 先写临时文件再改名，避免写到一半被中断留下损坏的 JSON
      const tmp = `${this.path}.tmp`
      await fs.writeFile(tmp, JSON.stringify(this.history), 'utf-8')
      await fs.rename(tmp, this.path)
    } catch (err) {
      this.dirty = true
      console.error('[UsageHistory] Save failed:', err)
    } finally {
      this.writing = false
      if (this.pending) {
        this.pending = false
        void this.save()
      }
    }
  }
}
