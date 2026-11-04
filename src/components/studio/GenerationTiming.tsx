import { useEffect, useState } from 'react'
import { Clock3Icon } from 'lucide-react'

export function GenerationTiming({ timing, isGenerating, isComfy }: {
  timing: { startedAt: number; finishedAt: number | null } | null
  isGenerating: boolean
  isComfy: boolean
}) {
  const [now, setNow] = useState(() => Date.now())
  const running = timing !== null && timing.finishedAt === null

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [running, timing?.startedAt])

  if (!timing && !isGenerating) return null
  const elapsed = timing ? Math.max(0, (timing.finishedAt ?? now) - timing.startedAt) / 1000 : 0

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-background px-3 py-2 text-xs">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Clock3Icon className="size-3.5" aria-hidden="true" />
        {!timing ? '正在准备参考图…' : isComfy ? '接口 / 跟踪耗时（含排队）' : '接口耗时'}
      </span>
      {timing && <span role="timer" aria-label="接口耗时" className="font-mono tabular-nums">{elapsed.toFixed(1)} 秒{running ? ' · 计时中' : ' · 已结束'}</span>}
    </div>
  )
}
