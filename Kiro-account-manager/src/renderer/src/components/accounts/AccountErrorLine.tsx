import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, Copy, X } from 'lucide-react'
import { Button } from '../ui'
import { cn } from '@/lib/utils'

interface Props {
  error: string
  isEn: boolean
  /** 单行错误文本的样式（卡片 / 列表行各自的配色与字号） */
  className?: string
  /** 是否显示前置警告图标 */
  showIcon?: boolean
}

/**
 * 账号错误信息：单行截断展示，旁边一个复制按钮复制完整内容；
 * 点击文字弹出完整详情，可选中复制。
 */
export function AccountErrorLine({ error, isEn, className, showIcon }: Props): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const copy = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(error)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用时打开详情，让用户手动选中复制
      setOpen(true)
    }
  }

  const copyLabel = copied ? (isEn ? 'Copied' : '已复制') : isEn ? 'Copy error' : '复制错误信息'

  return (
    <>
      <div className={cn('flex items-center gap-1.5 min-w-0', className)}>
        {showIcon && <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpen(true)
          }}
          className="truncate flex-1 min-w-0 text-left hover:underline"
          title={isEn ? 'Click to view the full error' : '点击查看完整错误'}
        >
          {error}
        </button>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 opacity-70 hover:opacity-100"
          title={copyLabel}
          aria-label={copyLabel}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
            <div
              role="dialog"
              aria-modal="true"
              aria-label={isEn ? 'Error details' : '错误详情'}
              className="relative bg-background rounded-xl shadow-2xl w-full max-w-lg m-4 border overflow-hidden"
            >
              <div className="p-4 border-b flex items-center justify-between">
                <span className="font-semibold text-sm">{isEn ? 'Error Details' : '错误详情'}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setOpen(false)}
                  aria-label={isEn ? 'Close' : '关闭'}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="p-4 space-y-3">
                <div className="text-xs font-mono bg-muted/50 p-3 rounded-lg border break-all whitespace-pre-wrap max-h-[50vh] overflow-y-auto select-text">
                  {error}
                </div>
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={copy}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? (isEn ? 'Copied' : '已复制') : isEn ? 'Copy' : '复制'}
                  </Button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
