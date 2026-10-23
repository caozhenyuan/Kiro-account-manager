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
  } = {}
): Account {
  return {
    id,
    status: over.status ?? 'active',
    usage: { current: over.current ?? 0, limit: over.limit ?? 1000, nextResetDate: over.reset },
    subscription: { type: over.type ?? 'Pro', title: over.title }
  } as unknown as Account
}

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
      '2026-10-16': { a: snap(100), b: snap(10) },
      '2026-10-17': { a: snap(130), b: snap(20) },
      '2026-10-18': { a: snap(130), b: snap(25) },
      // 10-19 应用没开：10-20 的差值整段记到 10-20
      '2026-10-20': { a: snap(190), b: snap(35) }
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
      '2026-10-18': { a: snap(900) },
      '2026-10-19': { a: snap(950) },
      '2026-10-20': { a: snap(20) } // 重置后清零再用了一点
    }
    const { trend, resetCount } = buildTrend(h, NOW, 3)
    check('回落那天不计负消耗', trend[2].used === 0, String(trend[2].used))
    check('回落计为一次重置', resetCount === 1, String(resetCount))
    check('重置日仍标记为有数据', trend[2].hasData)
  }

  console.log('[smoke] 窗口外的重置不计入提示')
  {
    const h: UsageHistory = {
      '2026-08-01': { a: snap(900) },
      '2026-08-02': { a: snap(5) },
      '2026-10-19': { a: snap(10) },
      '2026-10-20': { a: snap(30) }
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
    check('只提取正常且有额度的账号', Object.keys(s).join() === 'a', Object.keys(s).join())
    check('current 保留两位小数', s.a.c === 12.35, String(s.a.c))
    check('带上订阅类型与重置日', s.a.t === 'Pro' && s.a.r === 'x')
    check(
      '非法输入返回空',
      Object.keys(extractSnapshots(null)).length === 0 &&
        Object.keys(extractSnapshots({})).length === 0
    )

    let hist = mergeSnapshots({}, { a: { c: 1, l: 10 } }, NOW)
    hist = mergeSnapshots(hist, { a: { c: 2, l: 10 }, b: { c: 3, l: 10 } }, NOW)
    check(
      '同一天后写覆盖先写，账号并集',
      hist['2026-10-20'].a.c === 2 && hist['2026-10-20'].b.c === 3
    )

    const old = new Date(NOW)
    old.setDate(old.getDate() - HISTORY_RETENTION_DAYS - 5)
    const oldKey = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`
    const pruned = mergeSnapshots({ [oldKey]: { a: { c: 1, l: 1 } } }, { a: { c: 2, l: 10 } }, NOW)
    check(`超过 ${HISTORY_RETENTION_DAYS} 天的快照被裁掉`, !(oldKey in pruned))
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
      check('落盘后同日只保留最后一次', raw['2026-10-20']?.a?.c === 9, JSON.stringify(raw))
      const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))
      check('不残留临时文件', leftovers.length === 0, leftovers.join())

      const reopened = new UsageHistoryStore(dir)
      check('重新打开能读回', (await reopened.get())['2026-10-20']?.a?.c === 9)

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
