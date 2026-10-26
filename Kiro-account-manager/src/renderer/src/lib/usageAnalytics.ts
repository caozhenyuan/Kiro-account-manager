// 月度额度分析：纯函数，输入账号 + 用量历史，输出看板所需的全部指标。
// 口径：只统计 status === 'active' 且 limit > 0 的账号，按各账号自己的计费周期汇总。
// 同一账号可在不同额度区域各有一份独立额度：当前区域取实时数据，
// 其它区域取历史里最近一次快照（重置日未过才算仍在本周期内）。

import type { Account } from '@/types/account'

const DAY_MS = 24 * 60 * 60 * 1000
/** 缺少 nextResetDate 时按自然月 */
const FALLBACK_CYCLE_DAYS = 30
/** 月底预测取最近几天的日均 */
const RECENT_WINDOW_DAYS = 7
/** 趋势图展示最近几天 */
export const TREND_DAYS = 30

export interface AccountDaySnapshot {
  c: number
  l: number
  t?: string
  r?: string
  g?: string
}
export type UsageHistory = Record<string, Record<string, AccountDaySnapshot>>

export interface TrendPoint {
  /** YYYY-MM-DD */
  day: string
  /** 当天消耗（负差值，如周期重置，已按 0 处理并计入 resetCount） */
  used: number
  /** 该天是否有足够快照算出消耗；false 表示缺数据而不是 0 消耗 */
  hasData: boolean
}

export interface SubscriptionSlice {
  type: string
  count: number
  limit: number
  used: number
}

export type ProjectionBasis = 'recent' | 'cycle' | 'none'

export interface MonthlyAnalytics {
  /** 账号数（按邮箱去重，同一人的多个额度区域只算一个） */
  accountCount: number
  /** 额度份数：账号 × 额度区域 */
  quotaCount: number
  /** 来自其它额度区域历史快照（非实时）的额度份数 */
  otherRegionCount: number
  /** 这些历史快照中最早的日期 YYYY-MM-DD；没有则 null */
  otherRegionOldestDay: string | null
  totalLimit: number
  totalUsed: number
  remaining: number
  percentUsed: number
  /** 各账号周期天数加权后的平均已过天数 / 总天数，用于展示"本周期进度" */
  cycleElapsedDays: number
  cycleTotalDays: number
  cycleRemainingDays: number
  /** 日均消耗；basis 说明口径 */
  dailyAverage: number
  dailyBasis: ProjectionBasis
  /** 周期末预测已用 */
  projectedUsed: number
  projectedPercent: number
  /** 预测会超出总额度 */
  willExceed: boolean
  /** 按当前日均，剩余额度还能撑几天；日均为 0 时为 null */
  daysUntilExhausted: number | null
  trend: TrendPoint[]
  /** 趋势窗口内有多少天因周期重置被忽略负差值 */
  resetCount: number
  /** 趋势中有数据的天数；< 2 时前端提示"历史数据积累中" */
  trendDaysWithData: number
  /** 有多少个账号缺少重置日期而采用了 30 天口径 */
  fallbackCycleAccounts: number
  bySubscription: SubscriptionSlice[]
}

interface CycleInfo {
  elapsedDays: number
  totalDays: number
  remainingDays: number
  isFallback: boolean
}

export function dayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 以 nextResetDate 倒推周期。重置日已过（数据陈旧）时顺延整月，避免出现负的剩余天数 */
export function cycleOf(nextResetDate: string | undefined, now: Date): CycleInfo {
  const reset = nextResetDate ? new Date(nextResetDate) : null
  if (!reset || Number.isNaN(reset.getTime())) {
    // 无重置日：按自然月，起点取本月 1 号
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const total = Math.round((end.getTime() - start.getTime()) / DAY_MS)
    const elapsed = Math.max(0, (now.getTime() - start.getTime()) / DAY_MS)
    return {
      elapsedDays: elapsed,
      totalDays: total,
      remainingDays: Math.max(0, total - elapsed),
      isFallback: true
    }
  }
  let end = reset
  // 陈旧的重置日：向后顺延整月直到落在未来
  let guard = 0
  while (end.getTime() <= now.getTime() && guard++ < 24) {
    end = new Date(
      end.getFullYear(),
      end.getMonth() + 1,
      end.getDate(),
      end.getHours(),
      end.getMinutes()
    )
  }
  const start = new Date(
    end.getFullYear(),
    end.getMonth() - 1,
    end.getDate(),
    end.getHours(),
    end.getMinutes()
  )
  const total = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS))
  const elapsed = Math.min(total, Math.max(0, (now.getTime() - start.getTime()) / DAY_MS))
  return {
    elapsedDays: elapsed,
    totalDays: total,
    remainingDays: Math.max(0, (end.getTime() - now.getTime()) / DAY_MS),
    isFallback: false
  }
}

/**
 * 每日消耗序列：对每个账号取相邻有快照两天的 current 差值，再按天汇总。
 * - 差值为负：周期已重置，该账号当天不计消耗，并计入 resetCount
 * - 两天之间有缺口（应用没开）：整段消耗记到后一天，不平均摊开，避免伪造曲线
 * - 某天没有任何账号可算差值：hasData=false
 */
export function buildTrend(
  history: UsageHistory,
  now: Date,
  days = TREND_DAYS
): { trend: TrendPoint[]; resetCount: number } {
  const windowDays: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    windowDays.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)))
  }
  const windowStart = windowDays[0]

  const keys = Object.keys(history).sort()
  const perDay = new Map<string, { used: number; has: boolean }>()
  const lastSeen = new Map<string, number>()
  let resetCount = 0

  // 窗口之前的快照也要走一遍：窗口第一天的差值需要前一天作基线
  for (const key of keys) {
    let used = 0
    let has = false
    for (const [id, snap] of Object.entries(history[key])) {
      const prev = lastSeen.get(id)
      lastSeen.set(id, snap.c)
      if (prev === undefined) continue
      has = true
      const delta = snap.c - prev
      if (delta < 0) {
        if (key >= windowStart) resetCount++
        continue
      }
      used += delta
    }
    perDay.set(key, { used, has })
  }

  const trend: TrendPoint[] = windowDays.map((day) => {
    const v = perDay.get(day)
    return { day, used: v ? Math.round(v.used * 100) / 100 : 0, hasData: !!v?.has }
  })
  return { trend, resetCount }
}

/** 与主进程 usageHistory.snapshotKey 保持一致 */
export function snapshotKey(id: string, region: string): string {
  return `${id}|${region}`
}

/** 与反代 getApiRegion 同口径：apiRegion → region → us-east-1 */
export function apiRegionOf(a: Account): string {
  return a.credentials?.apiRegion || a.credentials?.region || 'us-east-1'
}

interface QuotaEntry {
  limit: number
  used: number
  reset?: string
  plan: string
  /** 该额度所属的人（邮箱，缺省用账号 ID） */
  owner: string
  /** 来自历史快照而非实时数据 */
  fromHistory: boolean
  day?: string
}

/**
 * 对每个正常账号，找出它在「其它额度区域」的最近一次快照。
 * 仅当快照记录的重置日仍在未来（仍属本周期）才采用，过期的额度视为已重置、不再计入。
 */
function otherRegionEntries(
  accounts: Account[],
  history: UsageHistory,
  now: Date
): QuotaEntry[] {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const latest = new Map<string, { day: string; snap: AccountDaySnapshot }>()
  for (const day of Object.keys(history).sort()) {
    for (const [key, snap] of Object.entries(history[day])) {
      const cut = key.lastIndexOf('|')
      if (cut < 0) continue
      const id = key.slice(0, cut)
      const region = key.slice(cut + 1)
      const acc = byId.get(id)
      if (!acc || region === apiRegionOf(acc)) continue
      latest.set(key, { day, snap })
    }
  }
  const out: QuotaEntry[] = []
  for (const [key, { day, snap }] of latest) {
    const reset = snap.r ? new Date(snap.r) : null
    if (!reset || Number.isNaN(reset.getTime()) || reset.getTime() <= now.getTime()) continue
    if (!(snap.l > 0)) continue
    const acc = byId.get(key.slice(0, key.lastIndexOf('|')))!
    out.push({
      limit: snap.l,
      used: snap.c,
      reset: snap.r,
      plan: snap.t || 'Free',
      owner: (acc.email || acc.id).toLowerCase(),
      fromHistory: true,
      day
    })
  }
  return out
}

export function computeMonthlyAnalytics(
  accounts: Iterable<Account>,
  history: UsageHistory,
  now: Date = new Date()
): MonthlyAnalytics {
  let totalLimit = 0
  let totalUsed = 0
  let fallbackCycleAccounts = 0
  let elapsedWeighted = 0
  let totalWeighted = 0
  let remainingWeighted = 0
  // 周期末预测需要按账号分别外推（各自周期长度不同）
  let projectedByCycle = 0
  const subs = new Map<string, SubscriptionSlice>()

  const active = [...accounts].filter(
    (a) => a.status === 'active' && a.usage && (a.usage.limit ?? 0) > 0
  )
  const entries: QuotaEntry[] = [
    ...active.map((a) => ({
      limit: a.usage.limit,
      used: a.usage.current ?? 0,
      reset: a.usage.nextResetDate,
      plan: a.subscription?.title || a.subscription?.type || 'Free',
      owner: (a.email || a.id).toLowerCase(),
      fromHistory: false
    })),
    ...otherRegionEntries(active, history, now)
  ]
  const owners = new Set<string>()
  const historyDays: string[] = []

  for (const e of entries) {
    const { limit, used } = e
    owners.add(e.owner)
    if (e.fromHistory && e.day) historyDays.push(e.day)
    totalLimit += limit
    totalUsed += used

    const cyc = cycleOf(e.reset, now)
    if (cyc.isFallback) fallbackCycleAccounts++
    // 以额度加权，大账号对"周期进度"的影响更大
    elapsedWeighted += cyc.elapsedDays * limit
    totalWeighted += cyc.totalDays * limit
    remainingWeighted += cyc.remainingDays * limit
    // 周期消耗速率外推：已用 / 已过天数 × 周期总天数；周期刚开始（不足半天）时不外推，沿用已用
    projectedByCycle += cyc.elapsedDays >= 0.5 ? (used / cyc.elapsedDays) * cyc.totalDays : used

    const type = e.plan
    const slice = subs.get(type) ?? { type, count: 0, limit: 0, used: 0 }
    slice.count++
    slice.limit += limit
    slice.used += used
    subs.set(type, slice)
  }

  const remaining = totalLimit - totalUsed
  const percentUsed = totalLimit > 0 ? (totalUsed / totalLimit) * 100 : 0
  const cycleTotalDays = totalLimit > 0 ? totalWeighted / totalLimit : FALLBACK_CYCLE_DAYS
  const cycleElapsedDays = totalLimit > 0 ? elapsedWeighted / totalLimit : 0
  const cycleRemainingDays = totalLimit > 0 ? remainingWeighted / totalLimit : 0

  const { trend, resetCount } = buildTrend(history, now)
  const withData = trend.filter((p) => p.hasData)

  // 日均：优先用最近 N 天真实消耗；样本不足（< 2 天）回退到"周期已用 ÷ 已过天数"
  let dailyAverage = 0
  let dailyBasis: ProjectionBasis = 'none'
  const recent = withData.slice(-RECENT_WINDOW_DAYS)
  if (recent.length >= 2) {
    dailyAverage = recent.reduce((s, p) => s + p.used, 0) / recent.length
    dailyBasis = 'recent'
  } else if (cycleElapsedDays >= 0.5 && totalUsed > 0) {
    dailyAverage = totalUsed / cycleElapsedDays
    dailyBasis = 'cycle'
  }

  // 周期末预测：已用 + 日均 × 剩余天数（recent 口径）；cycle 口径直接用逐账号外推
  let projectedUsed = totalUsed
  if (dailyBasis === 'recent') projectedUsed = totalUsed + dailyAverage * cycleRemainingDays
  else if (dailyBasis === 'cycle') projectedUsed = projectedByCycle
  const projectedPercent = totalLimit > 0 ? (projectedUsed / totalLimit) * 100 : 0

  return {
    accountCount: owners.size,
    quotaCount: entries.length,
    otherRegionCount: historyDays.length,
    otherRegionOldestDay: historyDays.length > 0 ? historyDays.sort()[0] : null,
    totalLimit,
    totalUsed,
    remaining,
    percentUsed,
    cycleElapsedDays,
    cycleTotalDays,
    cycleRemainingDays,
    dailyAverage,
    dailyBasis,
    projectedUsed,
    projectedPercent,
    willExceed: dailyBasis !== 'none' && projectedUsed > totalLimit,
    daysUntilExhausted: dailyAverage > 0 ? Math.max(0, remaining) / dailyAverage : null,
    trend,
    resetCount,
    trendDaysWithData: withData.length,
    fallbackCycleAccounts,
    bySubscription: [...subs.values()].sort((a, b) => b.limit - a.limit)
  }
}
