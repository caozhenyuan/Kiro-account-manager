import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useAccountsStore } from '@/store/accounts'
import type { Account } from '@/types/account'
import { cn } from '@/lib/utils'

/** 账号配置的额度区域（与反代 getApiRegion 同口径） */
function configuredApiRegion(account: Account): string {
  return account.credentials?.apiRegion || account.credentials?.region || 'us-east-1'
}

/** Kiro 后端只有 us-east-1 / eu-central-1 两个端点，其它区域按前缀归一 */
function regionHost(region: string): string {
  return region.startsWith('eu-') ? 'eu-central-1' : 'us-east-1'
}

/** 用量来自另一额度区域时返回该区域，否则 null */
function regionMismatch(account: Account): string | null {
  const served = account.usage?.servedRegion
  if (!served) return null
  return regionHost(served) === regionHost(configuredApiRegion(account)) ? null : served
}

interface Props {
  account: Account
  isEn: boolean
  className?: string
  /** 紧凑模式：只显示图标和实际区域，说明放在悬停提示里，点击即切换 */
  compact?: boolean
}

/**
 * 额度区域查询失败、用量回落到另一区域时的提示。
 * 点击把额度区域切到实际返回数据的区域并重新查询。
 */
export function RegionMismatchNotice({
  account,
  isEn,
  className,
  compact
}: Props): React.ReactNode {
  const { updateAccount, checkAccountStatus } = useAccountsStore()
  const [switching, setSwitching] = useState(false)
  const served = regionMismatch(account)
  if (!served) return null

  const configured = regionHost(configuredApiRegion(account))
  const label = isEn
    ? `${configured} unavailable, showing ${served} quota`
    : `${configured} 不可用，当前显示 ${served} 额度`
  const action = isEn ? `Switch to ${served}` : `切换到 ${served}`

  const handleSwitch = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    setSwitching(true)
    try {
      updateAccount(account.id, {
        profileArn: undefined,
        credentials: { ...account.credentials, apiRegion: served, profileArn: undefined }
      })
      await checkAccountStatus(account.id)
    } finally {
      setSwitching(false)
    }
  }

  const detail = isEn
    ? `The ${configured} quota query failed, so the numbers shown come from ${served}. The proxy still routes to ${configured}.`
    : `${configured} 额度查询失败，显示的用量来自 ${served}。反代仍按 ${configured} 路由。`

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleSwitch}
        disabled={switching}
        title={`${detail}\n${isEn ? 'Click to' : '点击'}${action}`}
        aria-label={isEn ? `${label}. ${action}` : `${label}，${action}`}
        className={cn(
          'inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400 hover:underline disabled:opacity-50',
          className
        )}
      >
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
        {served}
      </button>
    )
  }

  return (
    <div
      className={cn(
        'flex items-center gap-1 text-amber-600 dark:text-amber-400 min-w-0',
        className
      )}
      title={detail}
    >
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={handleSwitch}
        disabled={switching}
        className="shrink-0 underline underline-offset-2 hover:text-amber-700 disabled:opacity-50"
      >
        {switching ? (isEn ? 'Switching…' : '切换中…') : action}
      </button>
    </div>
  )
}
