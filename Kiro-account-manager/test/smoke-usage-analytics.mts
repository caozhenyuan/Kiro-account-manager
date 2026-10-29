// 冒烟测试：首页「月度额度分析」的计算口径与用量历史快照
// 运行：node_modules/.bin/esbuild test/smoke-usage-analytics.mts --bundle --platform=node --format=cjs \
//        --outfile=test/.smoke-usage-analytics.cjs && node test/.smoke-usage-analytics.cjs
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildTrend,
  computeMonthlyAnalytics,
  cycleOf,
  snapshotKey,
  type UsageHistory
} from '../src/renderer/src/lib/usageAnalytics'
import {
  extractSnapshots,
  mergeSnapshots,
  UsageHistoryStore,
  HISTORY_RETENTION_DAYS
} from '../src/main/usageHistory'
import type { Account } from '../src/renderer/src/types/account'

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) <= eps

// 固定"现在"：2026-10-20 12:00 本地时间
const NOW = new Date(2026, 9, 20, 12, 0, 0)
const iso = (y: number, m: number, d: number): string =>
  new Date(y, m - 1, d, 0, 0, 0).toISOString()

function account(
  id: string,
  over: {
    status?: string
    current?: number
    limit?: number
    reset?: string
    type?: string
    title?: string
    email?: string
    region?: string
    served?: string
  } = {}
): Account {
  return {
    id,
    email: over.email ?? `${id}@example.com`,
    status: over.status ?? 'active',
    usage: {
      current: over.current ?? 0,
      limit: over.limit ?? 1000,
      nextResetDate: over.reset,
      servedRegion: over.served
    },
    subscription: { type: over.type ?? 'Pro', title: over.title },
    credentials: { region: 'us-east-1', apiRegion: over.region }
  } as unknown as Account
}

const R = 'us-east-1'
const k = (id: string, region = R): string => snapshotKey(id, region)

function snap(
  c: number,
  extra: Partial<{ l: number; t: string; r: string }> = {}
): {
  c: number
  l: number
} {
  return { c, l: 1000, ...extra }
}

async function main(): Promise<void> {
  console.log('[smoke] 周期推算')
  {
    const c = cycleOf(iso(2026, 11, 1), NOW)
    check('重置日 11-01：总周期 31 天', c.totalDays === 31, String(c.totalDays))
    check('已过约 19.5 天（10-01 起算）', near(c.elapsedDays, 19.5, 0.05), String(c.elapsedDays))
    check('剩余约 11.5 天', near(c.remainingDays, 11.5, 0.05), String(c.remainingDays))
    check('非回退口径', !c.isFallback)

    const stale = cycleOf(iso(2026, 10, 5), NOW)
    check(
      '陈旧重置日（已过）顺延到下月，剩余天数为正',
      stale.remainingDays > 0,
      String(stale.remainingDays)
    )

    const none = cycleOf(undefined, NOW)
    check(
      '缺少重置日：按自然月并标记回退',
      none.isFallback && none.totalDays === 31,
      JSON.stringify(none)
    )
    const bad = cycleOf('not-a-date', NOW)
    check('非法日期字符串走回退口径', bad.isFallback)
  }

  console.log('[smoke] 汇总与账号范围')
  {
    const accounts = [
      account('a', { current: 300, limit: 1000, reset: iso(2026, 11, 1), type: 'Pro' }),
      account('b', { current: 100, limit: 500, reset: iso(2026, 11, 1), type: 'Free' }),
      account('banned', { status: 'error', current: 999, limit: 1000 }),
      account('nolimit', { current: 5, limit: 0 })
    ]
    const r = computeMonthlyAnalytics(accounts, {}, NOW)
    check('只统计正常且 limit>0 的账号', r.accountCount === 2, String(r.accountCount))
    check(
      '总额度 1500，已用 400，剩余 1100',
      r.totalLimit === 1500 && r.totalUsed === 400 && r.remaining === 1100
    )
    check('使用率约 26.67%', near(r.percentUsed, 26.67), String(r.percentUsed))
    check(
      '订阅分布按额度降序',
      r.bySubscription[0]?.type === 'Pro' && r.bySubscription[1]?.type === 'Free'
    )
    check('无历史：趋势天数为 0', r.trendDaysWithData === 0)
    check('无历史：日均回退到周期口径', r.dailyBasis === 'cycle', r.dailyBasis)
    // 周期口径：每个账号 已用/已过天数×周期天数；两账号周期相同
    const expected = (400 / 19.5) * 31
    check(
      '周期口径月底预测',
      near(r.projectedUsed, expected, 0.5),
      `${r.projectedUsed} vs ${expected}`
    )
    check('预测未超额', !r.willExceed)
  }

  console.log('[smoke] 超额预测与周期刚开始')
  {
    const over = computeMonthlyAnalytics(
      [account('a', { current: 900, limit: 1000, reset: iso(2026, 11, 1) })],
      {},
      NOW
    )
    check('900/1000 且已过 19.5 天：预测超额', over.willExceed)
    check(
      '能撑天数 > 0 且较短',
      (over.daysUntilExhausted ?? -1) > 0 && (over.daysUntilExhausted ?? 99) < 5
    )

    const fresh = computeMonthlyAnalytics(
      [
        account('a', {
          current: 10,
          limit: 1000,
          reset: new Date(NOW.getTime() + 30.9 * 86400000).toISOString()
        })
      ],
      {},
      NOW
    )
    check(
      '周期不足半天：不外推，沿用已用',
      fresh.dailyBasis === 'none' && fresh.projectedUsed === 10
    )

    const zero = computeMonthlyAnalytics(
      [account('a', { current: 0, limit: 1000, reset: iso(2026, 11, 1) })],
      {},
      NOW
    )
    check(
      '已用为 0：日均 0、预测 0、撑天数为 null',
      zero.dailyAverage === 0 && zero.projectedUsed === 0 && zero.daysUntilExhausted === null
    )
  }

  console.log('[smoke] 每日趋势')
  {
    const h: UsageHistory = {
      '2026-10-16': { [k('a')]: snap(100), [k('b')]: snap(10) },
      '2026-10-17': { [k('a')]: snap(130), [k('b')]: snap(20) },
      '2026-10-18': { [k('a')]: snap(130), [k('b')]: snap(25) },
      // 10-19 应用没开：10-20 的差值整段记到 10-20
      '2026-10-20': { [k('a')]: snap(190), [k('b')]: snap(35) }
    }
    const { trend, resetCount } = buildTrend(h, NOW, 7)
    const by = Object.fromEntries(trend.map((p) => [p.day, p]))
    check('窗口 7 天', trend.length === 7 && trend[6].day === '2026-10-20')
    check('首日无基线：无数据', by['2026-10-16'].hasData === false)
    check(
      '10-17 消耗 = (130-100)+(20-10) = 40',
      by['2026-10-17'].used === 40,
      String(by['2026-10-17'].used)
    )
    check('10-18 消耗 = 0+5 = 5', by['2026-10-18'].used === 5, String(by['2026-10-18'].used))
    check(
      '10-19 缺数据而非 0 消耗',
      by['2026-10-19'].hasData === false && by['2026-10-19'].used === 0
    )
    check(
      '10-20 补记整段缺口 = 60+10 = 70',
      by['2026-10-20'].used === 70,
      String(by['2026-10-20'].used)
    )
    check('无重置', resetCount === 0)

    const withHistory = computeMonthlyAnalytics(
      [
        account('a', { current: 190, limit: 1000, reset: iso(2026, 11, 1) }),
        account('b', { current: 35, limit: 1000, reset: iso(2026, 11, 1) })
      ],
      h,
      NOW
    )
    check(
      '样本 ≥ 2 天：日均用 recent 口径',
      withHistory.dailyBasis === 'recent',
      withHistory.dailyBasis
    )
    check(
      '日均 = (40+5+70)/3',
      near(withHistory.dailyAverage, 115 / 3),
      String(withHistory.dailyAverage)
    )
    check(
      '预测 = 已用 + 日均×剩余天数',
      near(withHistory.projectedUsed, 225 + (115 / 3) * withHistory.cycleRemainingDays, 0.01)
    )
  }

  console.log('[smoke] 周期重置（用量回落）')
  {
    const h: UsageHistory = {
      '2026-10-18': { [k('a')]: snap(900) },
      '2026-10-19': { [k('a')]: snap(950) },
      '2026-10-20': { [k('a')]: snap(20) } // 重置后清零再用了一点
    }
    const { trend, resetCount } = buildTrend(h, NOW, 3)
    check('回落那天不计负消耗', trend[2].used === 0, String(trend[2].used))
    check('回落计为一次重置', resetCount === 1, String(resetCount))
    check('重置日仍标记为有数据', trend[2].hasData)
  }

  console.log('[smoke] 窗口外的重置不计入提示')
  {
    const h: UsageHistory = {
      '2026-08-01': { [k('a')]: snap(900) },
      '2026-08-02': { [k('a')]: snap(5) },
      '2026-10-19': { [k('a')]: snap(10) },
      '2026-10-20': { [k('a')]: snap(30) }
    }
    const { resetCount, trend } = buildTrend(h, NOW, 7)
    check('8 月的重置不在 7 天窗口内', resetCount === 0, String(resetCount))
    check('10-20 用 10-19 作基线 = 20', trend[6].used === 20, String(trend[6].used))
  }

  console.log('[smoke] 快照提取与合并')
  {
    const data = {
      accounts: {
        a: {
          status: 'active',
          usage: { current: 12.345, limit: 100, nextResetDate: 'x' },
          subscription: { type: 'Pro' }
        },
        b: { status: 'error', usage: { current: 1, limit: 10 } },
        c: { status: 'active', usage: { current: 1, limit: 0 } },
        d: { status: 'active', usage: { current: 'oops', limit: 10 } }
      }
    }
    const s = extractSnapshots(data)
    check('只提取正常且有额度的账号', Object.keys(s).join() === k('a'), Object.keys(s).join())
    check('current 保留两位小数', s[k('a')].c === 12.35, String(s[k('a')].c))
    check('带上订阅类型、重置日与区域', s[k('a')].t === 'Pro' && s[k('a')].r === 'x' && s[k('a')].g === R)
    check(
      '非法输入返回空',
      Object.keys(extractSnapshots(null)).length === 0 &&
        Object.keys(extractSnapshots({})).length === 0
    )

    let hist = mergeSnapshots({}, { [k('a')]: { c: 1, l: 10 } }, NOW)
    hist = mergeSnapshots(hist, { [k('a')]: { c: 2, l: 10 }, [k('b')]: { c: 3, l: 10 } }, NOW)
    check(
      '同一天后写覆盖先写，账号并集',
      hist['2026-10-20'][k('a')].c === 2 && hist['2026-10-20'][k('b')].c === 3
    )

    const old = new Date(NOW)
    old.setDate(old.getDate() - HISTORY_RETENTION_DAYS - 5)
    const oldKey = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`
    const pruned = mergeSnapshots({ [oldKey]: { [k('a')]: { c: 1, l: 1 } } }, { [k('a')]: { c: 2, l: 10 } }, NOW)
    check(`超过 ${HISTORY_RETENTION_DAYS} 天的快照被裁掉`, !(oldKey in pruned))
  }

  console.log('[smoke] 同一邮箱两个额度区域')
  {
    const EU = 'eu-central-1'
    const RESET = iso(2026, 11, 1)

    // 趋势：同一账号来回切换区域，各区域独立差分，不跨区域相减
    const h: UsageHistory = {
      '2026-10-18': { [k('a', R)]: snap(10277) },
      // 10-19 切到法兰克福：美东快照停止更新，欧洲从 0 开始
      '2026-10-19': { [k('a', EU)]: snap(0) },
      '2026-10-20': { [k('a', EU)]: snap(15) }
    }
    const { trend, resetCount } = buildTrend(h, NOW, 3)
    check('切换区域不产生"周期重置"误报', resetCount === 0, String(resetCount))
    check(
      '切换当天不会把 0 当成消耗或重置',
      trend[1].used === 0 && trend[1].hasData === false,
      JSON.stringify(trend[1])
    )
    check('欧洲区域 10-20 消耗 = 15', trend[2].used === 15, String(trend[2].used))

    // 切回美东：只记美东序列自己的增量（10300-10277），不会拿它去和欧洲的 0/15 相减
    const back: UsageHistory = {
      ...h,
      '2026-10-20': { [k('a', R)]: snap(10300), [k('a', EU)]: snap(15) }
    }
    const t2 = buildTrend(back, NOW, 3).trend
    check('切回美东：美东增量 23 + 欧洲增量 15 = 38', t2[2].used === 38, String(t2[2].used))

    // 汇总：当前区域取实时值，另一区域取历史快照（重置日未过）
    const history: UsageHistory = {
      '2026-10-18': {
        [k('a', R)]: { c: 1800, l: 10000, t: 'KIRO POWER', r: RESET, g: R }
      },
      '2026-10-20': { [k('a', EU)]: { c: 15, l: 2000, t: 'KIRO PRO+', r: RESET, g: EU } }
    }
    const now = computeMonthlyAnalytics(
      [account('a', { email: 'Me@Corp.com', region: EU, current: 15, limit: 2000, reset: RESET, title: 'KIRO PRO+' })],
      history,
      NOW
    )
    check('账号按邮箱去重：1 个账号', now.accountCount === 1, String(now.accountCount))
    check('额度份数 2', now.quotaCount === 2, String(now.quotaCount))
    check('另一区域来自历史快照 1 份', now.otherRegionCount === 1)
    check('最早快照日期', now.otherRegionOldestDay === '2026-10-18', String(now.otherRegionOldestDay))
    check(
      '总额度 = 2000 + 10000',
      now.totalLimit === 12000 && now.totalUsed === 1815,
      `${now.totalLimit}/${now.totalUsed}`
    )
    check(
      '订阅分布按套餐名拆开且份数合计等于额度份数',
      now.bySubscription.length === 2 &&
        now.bySubscription.reduce((s, x) => s + x.count, 0) === now.quotaCount,
      JSON.stringify(now.bySubscription)
    )

    // 另一区域快照的重置日已过：视为已重置，不再计入
    const staleHistory: UsageHistory = {
      '2026-09-10': { [k('a', R)]: { c: 9000, l: 10000, t: 'KIRO POWER', r: iso(2026, 10, 1), g: R } }
    }
    const stale = computeMonthlyAnalytics(
      [account('a', { region: EU, current: 15, limit: 2000, reset: RESET })],
      staleHistory,
      NOW
    )
    check(
      '过期的其它区域快照不计入',
      stale.otherRegionCount === 0 && stale.totalLimit === 2000 && stale.quotaCount === 1,
      JSON.stringify([stale.otherRegionCount, stale.totalLimit, stale.quotaCount])
    )

    // 同一邮箱建了两条记录（各一个区域）：账号数合并为 1，额度份数 2，且不重复计入历史
    const twoRecords = computeMonthlyAnalytics(
      [
        account('r1', { email: 'me@corp.com', region: R, current: 100, limit: 10000, reset: RESET, title: 'KIRO POWER' }),
        account('r2', { email: 'ME@corp.com', region: EU, current: 15, limit: 2000, reset: RESET, title: 'KIRO PRO+' })
      ],
      {
        '2026-10-20': {
          [k('r1', R)]: { c: 100, l: 10000, t: 'KIRO POWER', r: RESET, g: R },
          [k('r2', EU)]: { c: 15, l: 2000, t: 'KIRO PRO+', r: RESET, g: EU }
        }
      },
      NOW
    )
    check(
      '两条记录同邮箱：账号 1、额度 2、不用历史重复计入',
      twoRecords.accountCount === 1 &&
        twoRecords.quotaCount === 2 &&
        twoRecords.otherRegionCount === 0 &&
        twoRecords.totalLimit === 12000,
      JSON.stringify([twoRecords.accountCount, twoRecords.quotaCount, twoRecords.otherRegionCount, twoRecords.totalLimit])
    )

    // 非 active 账号不应借历史把另一区域的额度算进来
    const banned = computeMonthlyAnalytics(
      [account('a', { status: 'error', region: EU, current: 15, limit: 2000, reset: RESET })],
      history,
      NOW
    )
    check('异常账号的历史快照也不计入', banned.quotaCount === 0 && banned.totalLimit === 0)
  }

  console.log('[smoke] 快照按区域分序列')
  {
    const s = extractSnapshots({
      accounts: {
        a: {
          status: 'active',
          usage: { current: 1, limit: 10 },
          subscription: { type: 'Pro', title: 'KIRO PRO+' },
          credentials: { region: 'us-east-1', apiRegion: 'eu-central-1' }
        },
        b: {
          status: 'active',
          usage: { current: 2, limit: 10 },
          subscription: { type: 'Pro' },
          credentials: { region: 'eu-west-1' }
        },
        c: { status: 'active', usage: { current: 3, limit: 10 }, subscription: { type: 'Free' } }
      }
    })
    check('键含额度区域（apiRegion 优先）', k('a', 'eu-central-1') in s, Object.keys(s).join())
    check('无 apiRegion 回落登录区域，并归一到端点区域', k('b', 'eu-central-1') in s, Object.keys(s).join())
    check('都没有时回落 us-east-1', k('c', 'us-east-1') in s, Object.keys(s).join())
    check('订阅取套餐名', s[k('a', 'eu-central-1')].t === 'KIRO PRO+')
  }

  console.log('[smoke] 用量查询回落到另一区域')
  {
    const EU = 'eu-central-1'
    const RESET = iso(2026, 11, 1)

    // 额度区域仍是美东，但美东查询失败、数据来自法兰克福：快照记在法兰克福名下
    const s = extractSnapshots({
      accounts: {
        a: {
          status: 'active',
          usage: { current: 10000, limit: 10000, nextResetDate: RESET, servedRegion: EU },
          subscription: { title: 'KIRO POWER' },
          credentials: { region: R, apiRegion: R }
        }
      }
    })
    check('回落数据记在实际区域', Object.keys(s).join() === k('a', EU), Object.keys(s).join())

    // 回落期间：实时那份算法兰克福；历史里旧的美东快照（重置日未过）仍算另一份额度
    const history: UsageHistory = {
      '2026-10-18': { [k('a', R)]: { c: 15000, l: 15000, t: 'KIRO POWER', r: RESET, g: R } },
      '2026-10-20': { [k('a', EU)]: { c: 10000, l: 10000, t: 'KIRO POWER', r: RESET, g: EU } }
    }
    const during = computeMonthlyAnalytics(
      [account('a', { region: R, served: EU, current: 10000, limit: 10000, reset: RESET })],
      history,
      NOW
    )
    check(
      '回落期间：法兰克福实时 + 美东快照，不重复计入法兰克福',
      during.quotaCount === 2 && during.otherRegionCount === 1 && during.totalLimit === 25000,
      JSON.stringify([during.quotaCount, during.otherRegionCount, during.totalLimit])
    )

    // 切到法兰克福后：结果与回落期间一致
    const after = computeMonthlyAnalytics(
      [account('a', { region: EU, served: EU, current: 10000, limit: 10000, reset: RESET })],
      history,
      NOW
    )
    check(
      '切换后：总额度不变，法兰克福不重复计入',
      after.quotaCount === 2 && after.totalLimit === 25000,
      JSON.stringify([after.quotaCount, after.totalLimit])
    )

    // v1.7.15 留下的未归一旧键（eu-west-1）与当前区域 eu-central-1 视为同一区域
    const legacy = computeMonthlyAnalytics(
      [account('a', { region: EU, current: 15, limit: 2000, reset: RESET })],
      { '2026-10-19': { [k('a', 'eu-west-1')]: { c: 10, l: 2000, r: RESET } } },
      NOW
    )
    check(
      '未归一的旧区域键不被当成另一份额度',
      legacy.quotaCount === 1 && legacy.totalLimit === 2000,
      JSON.stringify([legacy.quotaCount, legacy.totalLimit])
    )
    const legacyTrend = buildTrend(
      {
        '2026-10-19': { [k('a', 'eu-west-1')]: snap(10) },
        '2026-10-20': { [k('a', EU)]: snap(15) }
      },
      NOW,
      2
    ).trend
    check('未归一旧键与新键连续差分', legacyTrend[1].used === 5, String(legacyTrend[1].used))
  }

  console.log('[smoke] 月末重置日的周期推算')
  {
    // 重置日是 31 号、上个月只有 30 天：起点应钳到 30 号，周期约 30~31 天，而不是溢出到月初
    const c = cycleOf(new Date(2026, 9, 31, 0, 0).toISOString(), new Date(2026, 9, 20, 12, 0))
    check('周期总天数在 28~31 之间', c.totalDays >= 28 && c.totalDays <= 31, String(c.totalDays))
    check('已过天数不超过总天数', c.elapsedDays <= c.totalDays, `${c.elapsedDays}/${c.totalDays}`)
    // 2 月 28 日重置：向前倒推到 1 月 28 日
    const feb = cycleOf(new Date(2027, 1, 28, 0, 0).toISOString(), new Date(2027, 1, 10, 12, 0))
    check('2 月周期为 31 天', feb.totalDays === 31, String(feb.totalDays))
    // 3 月 31 日重置：上一周期起点钳到 2 月 28 日，总天数 31
    const mar = cycleOf(new Date(2027, 2, 31, 0, 0).toISOString(), new Date(2027, 2, 5, 12, 0))
    check('3 月 31 日重置：总天数 31', mar.totalDays === 31, String(mar.totalDays))
  }

  console.log('[smoke] 趋势只统计仍计入总额度的账号')
  {
    const h: UsageHistory = {
      '2026-10-18': { [k('live')]: snap(100), [k('gone')]: snap(500) },
      '2026-10-19': { [k('live')]: snap(110), [k('gone')]: snap(900) },
      '2026-10-20': { [k('live')]: snap(125), [k('gone')]: snap(1400) }
    }
    const all = buildTrend(h, NOW, 3).trend
    check('不过滤时已删除账号的消耗被计入', all[2].used === 515, String(all[2].used))
    const only = buildTrend(h, NOW, 3, new Set(['live'])).trend
    check('只统计 live 账号：10-19 消耗 10', only[1].used === 10, String(only[1].used))
    check('只统计 live 账号：10-20 消耗 15', only[2].used === 15, String(only[2].used))

    const analytics = computeMonthlyAnalytics(
      [account('live', { current: 125, limit: 1000, reset: '2026-11-01T00:00:00.000Z' })],
      h,
      NOW
    )
    check(
      '日均不含已删除账号的消耗',
      Math.abs(analytics.dailyAverage - 12.5) < 0.01,
      String(analytics.dailyAverage)
    )
  }

  console.log('[smoke] 历史存储落盘与恢复')
  {
    const dir = await fs.mkdtemp(join(tmpdir(), 'kam-usage-'))
    try {
      const store = new UsageHistoryStore(dir)
      await store.record(
        {
          accounts: {
            a: {
              status: 'active',
              usage: { current: 5, limit: 100 },
              subscription: { type: 'Pro' }
            }
          }
        },
        NOW
      )
      await store.record(
        {
          accounts: {
            a: {
              status: 'active',
              usage: { current: 9, limit: 100 },
              subscription: { type: 'Pro' }
            }
          }
        },
        NOW
      )
      await store.flush()
      const raw = JSON.parse(
        await fs.readFile(join(dir, 'usage-history.json'), 'utf-8')
      ) as UsageHistory
      check('落盘后同日只保留最后一次', raw['2026-10-20']?.[k('a')]?.c === 9, JSON.stringify(raw))
      const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))
      check('不残留临时文件', leftovers.length === 0, leftovers.join())

      const reopened = new UsageHistoryStore(dir)
      check('重新打开能读回', (await reopened.get())['2026-10-20']?.[k('a')]?.c === 9)

      await fs.writeFile(join(dir, 'usage-history.json'), '{ broken json', 'utf-8')
      const corrupt = new UsageHistoryStore(dir)
      check('文件损坏时从空历史开始而不抛错', Object.keys(await corrupt.get()).length === 0)

      const emptyStore = new UsageHistoryStore(dir, 'never.json')
      await emptyStore.record({ accounts: {} }, NOW)
      await emptyStore.flush()
      check(
        '没有可记录的账号时不写文件',
        !(await fs.stat(join(dir, 'never.json')).then(
          () => true,
          () => false
        ))
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  console.log(failures === 0 ? '[smoke] 全部通过 ✓' : `[smoke] ${failures} 项失败 ✗`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('[smoke] 运行异常:', e)
  process.exit(1)
})
