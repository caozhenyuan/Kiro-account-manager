// 额度区域开通提醒：下一个额度区域需手动开通，且要求上一个区域已用到一定量，
// 这里只根据当前区域的已用量判断是否该提醒，不探测未开通的区域。

import type { Account } from '@/types/account'
import { usageRegionOf } from './usageAnalytics'

export interface RegionReminder {
  account: Account
  region: string
  used: number
  /** 去重键：同一账号同一区域同一计费周期只提醒一次 */
  key: string
}

export function findRegionReminders(accounts: Iterable<Account>, threshold: number): RegionReminder[] {
  if (!(threshold > 0)) return []
  const out: RegionReminder[] = []
  for (const a of accounts) {
    if (a.status !== 'active') continue
    const used = a.usage?.current ?? 0
    if (!(used >= threshold)) continue
    const region = usageRegionOf(a)
    out.push({ account: a, region, used, key: `${a.id}|${region}|${a.usage?.nextResetDate ?? ''}` })
  }
  return out
}
