import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  /** 写入系统日志的区域标识，用于区分是哪一块崩了 */
  scope: string
  /** 子树内这些值变化时自动清除错误态（如账号列表数据更新后重新渲染） */
  resetKeys?: unknown[]
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

function sameKeys(a: unknown[] = [], b: unknown[] = []): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = (info.componentStack || '').trim().split('\n').slice(0, 8).join('\n')
    window.api.reportRendererError({
      scope: this.props.scope,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 8).join('\n'),
      componentStack: stack
    })
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && !sameKeys(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null })
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const isEn = navigator.language.toLowerCase().startsWith('en')
    return (
      <div
        role="alert"
        className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <AlertTriangle className="h-8 w-8 text-amber-500" aria-hidden="true" />
        <p className="text-sm font-medium">
          {isEn ? 'This section failed to render' : '该区域渲染出错'}
        </p>
        <p className="text-xs text-muted-foreground max-w-md break-words">{error.message}</p>
        <p className="text-xs text-muted-foreground">
          {isEn
            ? 'Your data is not affected. Details were written to System Logs.'
            : '数据未受影响，详细信息已写入系统日志。'}
        </p>
        <Button variant="outline" size="sm" onClick={this.handleRetry}>
          <RotateCw className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
          {isEn ? 'Retry' : '重试'}
        </Button>
      </div>
    )
  }
}
