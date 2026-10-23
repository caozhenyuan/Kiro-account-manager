import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Trash2, Download, RefreshCw, Search, Filter, ArrowDown, ChevronsDown, AlertCircle, Info, Bug, AlertTriangle, X } from 'lucide-react'
import { Button, Badge, Input } from '../ui'
import { useTranslation } from '../../hooks/useTranslation'
import { useVirtualizer } from '@tanstack/react-virtual'

interface LogEntry {
  timestamp: string
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  category: string
  message: string
  data?: unknown
  reqId?: string
}

type LogLevel = 'ALL' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const LEVEL_COLORS: Record<string, string> = {
  DEBUG: 'text-muted-foreground',
  INFO: 'text-blue-500',
  WARN: 'text-amber-500',
  ERROR: 'text-red-500'
}

const LEVEL_DOT: Record<string, string> = {
  DEBUG: 'bg-gray-400',
  INFO: 'bg-blue-400',
  WARN: 'bg-amber-400',
  ERROR: 'bg-red-400'
}

const LEVEL_ICONS: Record<string, React.ElementType> = {
  DEBUG: Bug,
  INFO: Info,
  WARN: AlertTriangle,
  ERROR: AlertCircle
}

const LEVEL_BTN_ACTIVE: Record<string, string> = {
  ALL: 'bg-primary text-primary-foreground',
  DEBUG: 'bg-gray-500 text-white',
  INFO: 'bg-blue-500 text-white',
  WARN: 'bg-amber-500 text-white',
  ERROR: 'bg-red-500 text-white'
}

export function LogsPage() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [filter, setFilter] = useState('')
  const [levelFilter, setLevelFilter] = useState<LogLevel>('ALL')
  const [categoryFilter, setCategoryFilter] = useState('all')
  // 点击日志行上的请求 ID 后只看该请求的全部日志
  const [reqIdFilter, setReqIdFilter] = useState<string | null>(null)
  const [timeRange, setTimeRange] = useState('all')
  // 显示数量默认 5K，用户改动后持久化到 localStorage（页面切换/重启后保留）
  const [displayLimit, setDisplayLimit] = useState<string>(() => {
    return localStorage.getItem('systemLogs_displayLimit') || '5000'
  })
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [newLogCount, setNewLogCount] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevLogCount = useRef(0)

  const fetchLogs = useCallback(async () => {
    try {
      const fetchCount = displayLimit === 'all' ? undefined : parseInt(displayLimit) || undefined
      const [allLogs, count] = await Promise.all([
        window.api.proxyGetLogs(fetchCount),
        window.api.proxyGetLogsCount()
      ])
      const newLogs = allLogs as LogEntry[]
      setLogs(newLogs)
      setTotalCount(count)
      // 如果用户不在底部，累计新日志数
      if (!isAtBottom && newLogs.length > prevLogCount.current) {
        setNewLogCount(prev => prev + (newLogs.length - prevLogCount.current))
      }
      prevLogCount.current = newLogs.length
    } catch {
      // ignore
    }
  }, [isAtBottom, displayLimit])

  useEffect(() => {
    setIsLoading(true)
    fetchLogs().finally(() => setIsLoading(false))
    pollRef.current = setInterval(fetchLogs, 1500)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchLogs])

  // 持久化 displayLimit
  useEffect(() => {
    localStorage.setItem('systemLogs_displayLimit', displayLimit)
  }, [displayLimit])

  // 智能滚动：用户在底部时自动跟随
  useEffect(() => {
    if (isAtBottom && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, isAtBottom])

  // 监听滚动位置
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setIsAtBottom(atBottom)
    if (atBottom) setNewLogCount(0)
  }, [])

  const scrollToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
      setIsAtBottom(true)
      setNewLogCount(0)
    }
  }

  const handleClear = async () => {
    await window.api.proxyClearLogs()
    setLogs([])
    setTotalCount(0)
    setNewLogCount(0)
  }

  const handleExport = () => {
    const content = filteredLogs.map(log => {
      const dataStr = log.data ? ` ${typeof log.data === 'string' ? log.data : JSON.stringify(log.data)}` : ''
      const reqStr = log.reqId ? `[#${log.reqId}]` : ''
      return `${log.timestamp} [${log.level}][${log.category}]${reqStr} ${log.message}${dataStr}`
    }).join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kiro-logs-${new Date().toISOString().slice(0, 10)}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const categories = useMemo(() => Array.from(new Set(logs.map(l => l.category))).sort(), [logs])

  const filteredLogs = useMemo(() => {
    const now = Date.now()
    const rangeMs = timeRange === '1h' ? 3600000 : timeRange === '6h' ? 21600000 : timeRange === '1d' ? 86400000 : timeRange === '7d' ? 604800000 : 0
    const lower = filter.toLowerCase()
    let result = logs.filter(log => {
      if (rangeMs > 0 && now - new Date(log.timestamp).getTime() > rangeMs) return false
      if (levelFilter !== 'ALL' && log.level !== levelFilter) return false
      if (categoryFilter !== 'all' && log.category !== categoryFilter) return false
      if (reqIdFilter && log.reqId !== reqIdFilter) return false
      if (lower) {
        return log.message.toLowerCase().includes(lower) ||
          log.category.toLowerCase().includes(lower) ||
          (log.reqId !== undefined && log.reqId.includes(lower)) ||
          (typeof log.data === 'string' && log.data.toLowerCase().includes(lower))
      }
      return true
    })
    if (displayLimit !== 'all') {
      const limit = parseInt(displayLimit)
      if (limit > 0) result = result.slice(-limit)
    }
    return result
  }, [logs, levelFilter, categoryFilter, reqIdFilter, timeRange, displayLimit, filter])

  const levelCounts = {
    ALL: logs.length,
    DEBUG: logs.filter(l => l.level === 'DEBUG').length,
    INFO: logs.filter(l => l.level === 'INFO').length,
    WARN: logs.filter(l => l.level === 'WARN').length,
    ERROR: logs.filter(l => l.level === 'ERROR').length
  }

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts)
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`
    } catch {
      return ts
    }
  }

  return (
    <div className="h-full flex flex-col p-4 gap-2">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="flex items-center gap-2 flex-1">
          <div className="p-1.5 rounded-lg bg-primary/10">
            <Bug className="h-4 w-4 text-primary" />
          </div>
          <span className="font-semibold text-sm">{isEn ? 'System Logs' : '系统日志'}</span>
          <Badge variant="secondary" className="text-[10px] font-mono">{totalCount.toLocaleString()}</Badge>
          {isLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={fetchLogs} title={isEn ? 'Refresh' : '刷新'}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleExport} title={isEn ? 'Export' : '导出'}>
          <Download className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs text-red-500 hover:text-red-600" onClick={handleClear} title={isEn ? 'Clear All' : '清空'}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* 搜索 + 筛选 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="h-7 pl-8 pr-7 text-xs bg-muted/30 border-0 focus-visible:ring-1"
            placeholder={isEn ? 'Filter by message, category...' : '按消息、分类搜索...'}
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
          {filter && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2" onClick={() => setFilter('')}>
              <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
            </button>
          )}
        </div>

        {/* 时间范围 */}
        <select
          className="h-7 px-2 text-[10px] rounded-md border border-border bg-muted/30 text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring"
          value={timeRange}
          onChange={e => setTimeRange(e.target.value)}
        >
          <option value="all">{isEn ? 'All Time' : '全部时间'}</option>
          <option value="1h">1h</option>
          <option value="6h">6h</option>
          <option value="1d">1d</option>
          <option value="7d">7d</option>
        </select>

        {/* 分类 */}
        <select
          className="h-7 px-2 text-[10px] rounded-md border border-border bg-muted/30 text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring max-w-[120px]"
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
        >
          <option value="all">{isEn ? 'All Categories' : '全部分类'}</option>
          {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
        </select>

        {/* 请求 ID 过滤（点击日志行上的 #id 设置） */}
        {reqIdFilter && (
          <button
            className="h-7 flex items-center gap-1 px-2 text-[10px] font-mono rounded-md bg-primary/15 text-primary hover:bg-primary/25"
            onClick={() => setReqIdFilter(null)}
            title={isEn ? 'Clear request filter' : '清除请求过滤'}
            aria-label={`${isEn ? 'Clear request filter' : '清除请求过滤'} #${reqIdFilter}`}
          >
            #{reqIdFilter}
            <X className="h-3 w-3" />
          </button>
        )}

        {/* 显示条数 */}
        <select
          className="h-7 px-2 text-[10px] rounded-md border border-border bg-muted/30 text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring"
          value={displayLimit}
          onChange={e => setDisplayLimit(e.target.value)}
        >
          <option value="all">{isEn ? 'All' : '全部'}</option>
          <option value="5000">5K</option>
          <option value="10000">10K</option>
          <option value="50000">50K</option>
          <option value="100000">100K</option>
        </select>

        {/* 级别筛选 */}
        <div className="flex items-center gap-0.5 bg-muted/30 rounded-lg p-0.5">
          {(['ALL', 'DEBUG', 'INFO', 'WARN', 'ERROR'] as LogLevel[]).map(level => (
            <button
              key={level}
              className={`px-2 py-1 rounded-md text-[10px] font-medium transition-all ${
                levelFilter === level
                  ? LEVEL_BTN_ACTIVE[level]
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
              onClick={() => setLevelFilter(level)}
            >
              {level === 'ALL' ? (isEn ? 'All' : '全部') : level}
              <span className="ml-1 opacity-70">{String(levelCounts[level])}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 日志列表（虚拟滚动） */}
      <div className="flex-1 min-h-0 relative rounded-lg border border-border/50 bg-card/50 overflow-hidden">
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <Filter className="h-8 w-8 opacity-20" />
            <span className="text-sm">{isEn ? 'No logs to display' : '暂无日志'}</span>
            {filter && <span className="text-xs">{isEn ? 'Try adjusting your filter' : '尝试调整搜索条件'}</span>}
          </div>
        ) : (
          <VirtualLogList
            logs={filteredLogs}
            expandedIdx={expandedIdx}
            onToggleExpand={(idx) => setExpandedIdx(expandedIdx === idx ? null : idx)}
            containerRef={containerRef}
            onScroll={handleScroll}
            isAtBottom={isAtBottom}
            formatTime={formatTime}
            onSelectReqId={(id) => {
              setReqIdFilter(id)
              setExpandedIdx(null)
            }}
            reqIdTitle={isEn ? 'Show only this request' : '只看该请求'}
          />
        )}

        {/* 回到底部浮动按钮 */}
        {!isAtBottom && (
          <button
            className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg hover:bg-primary/90 transition-all animate-in slide-in-from-bottom-2"
            onClick={scrollToBottom}
          >
            <ChevronsDown className="h-3.5 w-3.5" />
            {newLogCount > 0 ? (
              <>{isEn ? `${newLogCount} new` : `${newLogCount} 条新日志`}</>
            ) : (
              <>{isEn ? 'Bottom' : '回到底部'}</>
            )}
          </button>
        )}
      </div>

      {/* 底部状态栏 */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground flex-shrink-0 px-1">
        <div className="flex items-center gap-3">
          <span>{isEn ? 'Showing' : '显示'} <span className="font-mono">{filteredLogs.length.toLocaleString()}</span> / <span className="font-mono">{logs.length.toLocaleString()}</span></span>
          {levelCounts.ERROR > 0 && <span className="text-red-500">● {levelCounts.ERROR} {isEn ? 'errors' : '错误'}</span>}
          {levelCounts.WARN > 0 && <span className="text-amber-500">● {levelCounts.WARN} {isEn ? 'warnings' : '警告'}</span>}
        </div>
        <div className="flex items-center gap-1">
          <ArrowDown className={`h-3 w-3 ${isAtBottom ? 'text-green-500' : 'text-muted-foreground/40'}`} />
          <span>{isAtBottom ? (isEn ? 'Following' : '跟随中') : (isEn ? 'Scrolled up' : '已暂停跟随')}</span>
        </div>
      </div>
    </div>
  )
}

// 虚拟滚动日志列表 — 只渲染可视区域内的行
function VirtualLogList({
  logs, expandedIdx, onToggleExpand, containerRef, onScroll, isAtBottom, formatTime, onSelectReqId, reqIdTitle
}: {
  logs: LogEntry[]
  expandedIdx: number | null
  onToggleExpand: (idx: number) => void
  containerRef: React.RefObject<HTMLDivElement | null>
  onScroll: () => void
  isAtBottom: boolean
  formatTime: (ts: string) => string
  onSelectReqId: (reqId: string) => void
  reqIdTitle: string
}) {
  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (idx) => expandedIdx === idx ? 120 : 24,
    overscan: 20
  })

  // 自动滚到底
  useEffect(() => {
    if (isAtBottom && logs.length > 0) {
      virtualizer.scrollToIndex(logs.length - 1, { align: 'end' })
    }
  }, [logs.length, isAtBottom, virtualizer])

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto font-mono text-[11px] leading-5"
      onScroll={onScroll}
    >
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map(virtualRow => {
          const idx = virtualRow.index
          const log = logs[idx]
          const isExpanded = expandedIdx === idx
          const Icon = LEVEL_ICONS[log.level] || Info
          return (
            <div
              key={virtualRow.key}
              data-index={idx}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
              className={`group cursor-pointer transition-colors ${
                log.level === 'ERROR' ? 'bg-red-500/[0.04]' : log.level === 'WARN' ? 'bg-amber-500/[0.04]' : idx % 2 === 0 ? 'bg-transparent' : 'bg-muted/20'
              } hover:bg-muted/40`}
              onClick={() => onToggleExpand(idx)}
            >
              <div className="grid items-start px-3 py-[3px]" style={{ gridTemplateColumns: '8px 82px 80px 1fr' }}>
                <div className={`w-1.5 h-1.5 rounded-full mt-[7px] ${LEVEL_DOT[log.level]}`} />
                <span className="text-muted-foreground/60 tabular-nums select-all">{formatTime(log.timestamp)}</span>
                <span className={`text-[9px] px-1.5 py-[1px] rounded font-medium text-center truncate ${
                  log.category === 'Kiro' ? 'bg-blue-500/10 text-blue-500' :
                  log.category === 'ProxyServer' ? 'bg-violet-500/10 text-violet-500' :
                  log.category === 'KiroAPI' ? 'bg-cyan-500/10 text-cyan-500' :
                  'bg-muted/60 text-muted-foreground'
                }`}>{log.category}</span>
                <div className="min-w-0 pl-2">
                  {log.reqId && (
                    <button
                      className="mr-1.5 text-[9px] font-mono text-primary/70 hover:text-primary hover:underline"
                      title={reqIdTitle}
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectReqId(log.reqId!)
                      }}
                    >
                      #{log.reqId}
                    </button>
                  )}
                  <span className={`${LEVEL_COLORS[log.level]} break-all`}>{log.message}</span>
                  {log.data !== undefined && log.data !== null && (
                    <Icon className={`inline-block ml-1 h-3 w-3 opacity-30 group-hover:opacity-60 ${LEVEL_COLORS[log.level]}`} />
                  )}
                </div>
              </div>
              {isExpanded && log.data !== undefined && log.data !== null && (
                <div className="mx-3 mb-1 ml-[174px] p-2 rounded-md bg-muted/40 border border-border/30 text-[10px] overflow-x-auto">
                  <pre className="whitespace-pre-wrap break-all text-muted-foreground leading-4">
                    {String(typeof log.data === 'string' ? log.data : JSON.stringify(log.data, null, 2))}
                  </pre>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
