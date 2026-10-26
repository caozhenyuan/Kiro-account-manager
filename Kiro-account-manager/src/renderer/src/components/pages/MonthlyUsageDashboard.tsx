import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Gauge, PieChart, TrendingUp } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui'
import { cn } from '@/lib/utils'
import {
  computeMonthlyAnalytics,
  TREND_DAYS,
  type MonthlyAnalytics,
  type SubscriptionSlice,
  type TrendPoint,
  type UsageHistory
} from '@/lib/usageAnalytics'
import type { Account } from '@/types/account'

interface Props {
  accounts: Map<string, Account>
  isEn: boolean
  precision: number
}

// 订阅类型 → 图表颜色（与首页订阅徽标同一套归类规则）
function subscriptionTone(label: string): { text: string; bg: string } {
  const t = label.toUpperCase()
  if (t.includes('PRO+') || t.includes('PRO_PLUS') || t.includes('PROPLUS'))
    return { text: 'text-purple-500', bg: 'bg-purple-500' }
  if (t.includes('POWER')) return { text: 'text-amber-500', bg: 'bg-amber-500' }
  if (t.includes('ENTERPRISE') || t.includes('TEAMS'))
    return { text: 'text-teal-500', bg: 'bg-teal-500' }
  if (t.includes('PRO')) return { text: 'text-blue-500', bg: 'bg-blue-500' }
  return { text: 'text-gray-500', bg: 'bg-gray-500' }
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

export function MonthlyUsageDashboard({
  accounts,
  isEn,
  precision
}: Props): React.JSX.Element | null {
  const [history, setHistory] = useState<UsageHistory>({})

  // 历史由主进程在账号数据落盘时记录；账号变化后稍等片刻再读，避开落盘的防抖窗口
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      window.api
        .getUsageHistory()
        .then((h) => {
          if (!cancelled) setHistory(h ?? {})
        })
        .catch(() => undefined)
    }, 1500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [accounts])

  const data = useMemo(
    () => computeMonthlyAnalytics(accounts.values(), history),
    [accounts, history]
  )
  if (data.accountCount === 0) return null

  const basisText =
    data.dailyBasis === 'recent'
      ? isEn
        ? 'Avg of last 7 recorded days'
        : '近 7 个有记录日的均值'
      : data.dailyBasis === 'cycle'
        ? isEn
          ? 'Cycle used ÷ days elapsed'
          : '本周期已用 ÷ 已过天数'
        : isEn
          ? 'Not enough data yet'
          : '数据不足'

  const cards = [
    {
      key: 'total',
      label: isEn ? 'Total Quota' : '总额度',
      value: fmt(data.totalLimit),
      hint:
        data.quotaCount === data.accountCount
          ? isEn
            ? `${data.accountCount} active accounts`
            : `${data.accountCount} 个正常账号`
          : isEn
            ? `${data.accountCount} accounts · ${data.quotaCount} quotas`
            : `${data.accountCount} 个账号 · ${data.quotaCount} 份额度`,
      tone: 'text-blue-500'
    },
    {
      key: 'used',
      label: isEn ? 'Used' : '已使用',
      value: fmt(data.totalUsed),
      hint: `${data.percentUsed.toFixed(precision)}%`,
      tone: 'text-orange-500'
    },
    {
      key: 'remaining',
      label: isEn ? 'Remaining' : '剩余额度',
      value: fmt(Math.max(0, data.remaining)),
      hint:
        data.daysUntilExhausted !== null
          ? isEn
            ? `≈ ${fmt(data.daysUntilExhausted, 1)} days at current pace`
            : `按当前速度约可用 ${fmt(data.daysUntilExhausted, 1)} 天`
          : isEn
            ? 'Pace unknown'
            : '消耗速度未知',
      tone: data.remaining < 0 ? 'text-red-500' : 'text-green-600'
    },
    {
      key: 'daily',
      label: isEn ? 'Daily Average' : '日均消耗',
      value: data.dailyBasis === 'none' ? '-' : fmt(data.dailyAverage),
      hint: basisText,
      tone: 'text-purple-500'
    },
    {
      key: 'projected',
      label: isEn ? 'Projected at Cycle End' : '月底预测',
      value: data.dailyBasis === 'none' ? '-' : fmt(data.projectedUsed),
      hint:
        data.dailyBasis === 'none'
          ? basisText
          : data.willExceed
            ? isEn
              ? `Exceeds quota by ${fmt(data.projectedUsed - data.totalLimit)}`
              : `预计超出额度 ${fmt(data.projectedUsed - data.totalLimit)}`
            : `${data.projectedPercent.toFixed(precision)}% ${isEn ? 'of quota' : '额度'}`,
      tone: data.willExceed ? 'text-red-500' : 'text-teal-500'
    }
  ]

  return (
    <Card className="hover-lift">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Gauge className="h-4 w-4 text-primary" />
          </div>
          {isEn ? 'Monthly Quota Analysis' : '月度额度分析'}
          <span className="text-xs font-normal text-muted-foreground inline-flex items-center gap-1">
            <CalendarClock className="h-3 w-3" />
            {isEn
              ? `Cycle day ${Math.floor(data.cycleElapsedDays) + 1} / ${Math.round(data.cycleTotalDays)} · ${fmt(data.cycleRemainingDays, 1)} days left`
              : `周期第 ${Math.floor(data.cycleElapsedDays) + 1} / ${Math.round(data.cycleTotalDays)} 天 · 剩余 ${fmt(data.cycleRemainingDays, 1)} 天`}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {cards.map((c) => (
            <div key={c.key} className="p-3 bg-muted rounded-lg min-w-0">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className={cn('text-xl font-bold tabular-nums truncate', c.tone)} title={c.value}>
                {c.value}
              </p>
              <p className="text-[11px] text-muted-foreground line-clamp-2" title={c.hint}>
                {c.hint}
              </p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 min-w-0">
            <TrendChart data={data} isEn={isEn} />
          </div>
          <div className="min-w-0">
            <SubscriptionDonut slices={data.bySubscription} total={data.quotaCount} isEn={isEn} />
          </div>
        </div>

        {(data.fallbackCycleAccounts > 0 || data.resetCount > 0 || data.otherRegionCount > 0) && (
          <ul className="text-[11px] text-muted-foreground space-y-0.5 list-disc pl-4">
            {data.otherRegionCount > 0 && (
              <li>
                {isEn
                  ? `${data.otherRegionCount} quota(s) in other regions are taken from the latest snapshot (as of ${data.otherRegionOldestDay}); they refresh only when you switch to that region.`
                  : `${data.otherRegionCount} 份其它额度区域的额度取自最近一次快照（最早 ${data.otherRegionOldestDay}），切换到该区域后才会刷新。`}
              </li>
            )}
            {data.fallbackCycleAccounts > 0 && (
              <li>
                {isEn
                  ? `${data.fallbackCycleAccounts} account(s) have no reset date; calendar month is used for them.`
                  : `${data.fallbackCycleAccounts} 个账号缺少重置日期，按自然月计算周期。`}
              </li>
            )}
            {data.resetCount > 0 && (
              <li>
                {isEn
                  ? `${data.resetCount} cycle reset(s) detected in the last ${TREND_DAYS} days; the drop in usage is not counted as consumption.`
                  : `近 ${TREND_DAYS} 天检测到 ${data.resetCount} 次周期重置，用量回落的部分不计入消耗。`}
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 每日消耗柱状图
// ---------------------------------------------------------------------------

const CHART_W = 600
const CHART_H = 160
const PAD = { top: 10, right: 8, bottom: 22, left: 8 }

function TrendChart({ data, isEn }: { data: MonthlyAnalytics; isEn: boolean }): React.JSX.Element {
  const points = data.trend
  const maxUsed = Math.max(
    ...points.map((p) => p.used),
    data.dailyBasis === 'none' ? 0 : data.dailyAverage,
    1
  )
  const innerW = CHART_W - PAD.left - PAD.right
  const innerH = CHART_H - PAD.top - PAD.bottom
  const slot = innerW / points.length
  const barW = Math.max(2, slot * 0.7)
  const y = (v: number): number => PAD.top + innerH - (v / (maxUsed * 1.1)) * innerH
  const avgY = data.dailyBasis === 'none' ? null : y(data.dailyAverage)
  const tickEvery = 5
  const summary = isEn
    ? `Daily consumption over the last ${points.length} days, peak ${fmt(maxUsed)}`
    : `最近 ${points.length} 天每日消耗，峰值 ${fmt(maxUsed)}`

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-medium inline-flex items-center gap-1.5">
          <TrendingUp className="h-4 w-4 text-primary" />
          {isEn ? 'Daily Consumption' : '每日消耗趋势'}
          <span className="text-xs font-normal text-muted-foreground">
            {isEn ? `last ${TREND_DAYS} days` : `最近 ${TREND_DAYS} 天`}
          </span>
        </p>
        {avgY !== null && (
          <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
            <span className="inline-block w-4 border-t border-dashed border-purple-500" />
            {isEn ? 'daily avg' : '日均'}
          </span>
        )}
      </div>

      {data.trendDaysWithData < 2 ? (
        <div className="h-[160px] flex flex-col items-center justify-center rounded-lg bg-muted/40 text-xs text-muted-foreground gap-1 text-center px-4">
          <span>{isEn ? 'History is still being collected' : '历史数据积累中'}</span>
          <span>
            {isEn
              ? 'Usage snapshots are recorded daily from now on; the chart appears after two days of data.'
              : '从现在起每天记录一次用量快照，累计两天数据后显示趋势。'}
          </span>
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="w-full h-auto"
          role="img"
          aria-label={summary}
          preserveAspectRatio="none"
        >
          <title>{summary}</title>
          <line
            x1={PAD.left}
            x2={CHART_W - PAD.right}
            y1={PAD.top + innerH}
            y2={PAD.top + innerH}
            className="stroke-border"
            strokeWidth={1}
          />
          {points.map((p: TrendPoint, i) => {
            const x = PAD.left + i * slot + (slot - barW) / 2
            const h = p.hasData ? Math.max(p.used > 0 ? 1.5 : 0, PAD.top + innerH - y(p.used)) : 0
            return (
              <g key={p.day}>
                {p.hasData ? (
                  <rect
                    x={x}
                    y={PAD.top + innerH - h}
                    width={barW}
                    height={h}
                    rx={1.5}
                    className="fill-primary"
                  >
                    <title>{`${p.day}: ${fmt(p.used)}`}</title>
                  </rect>
                ) : (
                  <rect
                    x={x}
                    y={PAD.top + innerH - 2}
                    width={barW}
                    height={2}
                    rx={1}
                    className="fill-muted-foreground/30"
                  >
                    <title>{`${p.day}: ${isEn ? 'no data' : '无数据'}`}</title>
                  </rect>
                )}
                {i % tickEvery === 0 && (
                  <text
                    x={x + barW / 2}
                    y={CHART_H - 6}
                    textAnchor="middle"
                    className="fill-muted-foreground"
                    style={{ fontSize: 10 }}
                  >
                    {p.day.slice(5)}
                  </text>
                )}
              </g>
            )
          })}
          {avgY !== null && (
            <line
              x1={PAD.left}
              x2={CHART_W - PAD.right}
              y1={avgY}
              y2={avgY}
              className="stroke-purple-500"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          )}
        </svg>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 订阅类型分布（环形图 + 图例；图例带数值，不只靠颜色区分）
// ---------------------------------------------------------------------------

function SubscriptionDonut({
  slices,
  total,
  isEn
}: {
  slices: SubscriptionSlice[]
  total: number
  isEn: boolean
}): React.JSX.Element {
  const R = 40
  const C = 2 * Math.PI * R
  let offset = 0
  const summary = isEn
    ? `Subscription distribution: ${slices.map((s) => `${s.type} ${s.count}`).join(', ')}`
    : `订阅类型分布：${slices.map((s) => `${s.type} ${s.count} 个`).join('，')}`

  return (
    <div>
      <p className="text-sm font-medium inline-flex items-center gap-1.5 mb-1">
        <PieChart className="h-4 w-4 text-primary" />
        {isEn ? 'Subscription Mix' : '订阅类型分布'}
      </p>
      <div className="flex items-center gap-4">
        <svg
          viewBox="0 0 100 100"
          className="w-28 h-28 shrink-0 -rotate-90"
          role="img"
          aria-label={summary}
        >
          <title>{summary}</title>
          <circle cx={50} cy={50} r={R} fill="none" strokeWidth={14} className="stroke-muted" />
          {slices.map((s) => {
            const len = (s.count / total) * C
            const seg = (
              <circle
                key={s.type}
                cx={50}
                cy={50}
                r={R}
                fill="none"
                strokeWidth={14}
                stroke="currentColor"
                className={subscriptionTone(s.type).text}
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-offset}
              >
                <title>{`${s.type}: ${s.count}`}</title>
              </circle>
            )
            offset += len
            return seg
          })}
        </svg>
        <ul className="text-xs space-y-1 min-w-0 flex-1">
          {slices.map((s) => (
            <li key={s.type} className="flex items-start gap-2 min-w-0">
              <span
                className={cn(
                  'h-2.5 w-2.5 rounded-full shrink-0 mt-1',
                  subscriptionTone(s.type).bg
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate" title={s.type}>
                  {s.type}
                </p>
                <p className="tabular-nums text-muted-foreground truncate">
                  {s.count} · {fmt(s.used, 1)}/{fmt(s.limit, 0)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
