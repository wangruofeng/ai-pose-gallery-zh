import { CircleAlertIcon, Clock3Icon, DownloadIcon, LoaderCircleIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { GenerationTiming } from './GenerationTiming'
import type { GenerationJob, JobImage } from '@/types/generationJob'

const statusText: Record<JobImage['status'], string> = {
  queued: '排队中', preparing: '准备参考图', running: '生成中', succeeded: '已完成', failed: '生成失败', recoverable: '待恢复跟踪', interrupted: '已停止',
}
const isBusy = (image: JobImage) => ['queued', 'preparing', 'running'].includes(image.status)

export function GenerationJobs({ jobs, onPreview, onReuse, onResume, onForget, canResume }: {
  jobs: GenerationJob[]
  onPreview: (url: string) => void
  onReuse: (prompt: string) => void
  onResume: (jobId: string, index: number) => void
  onForget: (jobId: string, index: number) => Promise<void>
  canResume: (jobId: string, index: number) => boolean
}) {
  const running = jobs.filter(job => job.images.some(image => ['preparing', 'running'].includes(image.status))).length
  const queued = jobs.filter(job => !job.images.some(image => ['preparing', 'running'].includes(image.status)) && job.images.some(image => image.status === 'queued')).length
  return (
    <div className="space-y-4">
      <p role="status" className="text-xs text-muted-foreground">{running} 个任务运行中{queued ? ` · ${queued} 个排队中` : ''} · 最多并发 4 个任务</p>
      <div className="max-h-[720px] space-y-4 overflow-y-auto pr-1">
        {jobs.map(job => {
          const multiple = job.images.length > 1
          const completed = job.images.filter(image => image.status === 'succeeded').length
          const busy = job.images.some(isBusy)
          const status = job.images.some(image => ['preparing', 'running'].includes(image.status)) ? '运行中'
            : busy ? '排队中'
              : job.images.some(image => image.status === 'recoverable') ? '待恢复'
                : completed === job.images.length ? '已完成' : completed ? '部分完成' : '未完成'
          return (
            <article key={job.id} aria-label={job.title} className="space-y-3 rounded-xl border bg-background p-3 sm:p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">{job.title}{multiple && <span className="ml-1 font-normal tabular-nums text-muted-foreground">{completed}/{job.images.length} 张</span>}</h3>
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={job.summary}>{job.summary}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{job.model}</p>
                </div>
                <Badge variant="secondary">{status}</Badge>
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-ring">查看此任务提示词</summary>
                <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{job.prompt}</p>
                <Button size="sm" variant="ghost" onClick={() => onReuse(job.prompt)}>复制到编辑区</Button>
              </details>
              <div className={multiple ? 'grid gap-3 @min-[26rem]/section:grid-cols-2' : 'grid gap-3'}>
                {job.images.map(image => (
                  <div key={image.index} className="min-w-0 space-y-2">
                    {multiple && <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium">第 {image.index + 1} 张</span>
                      <span className={image.status === 'failed' || image.status === 'recoverable' ? 'text-destructive' : 'text-muted-foreground'}>{statusText[image.status]}</span>
                    </div>}
                    {image.imageUrl ? (
                      <>
                        <button type="button" aria-label={multiple ? `放大${job.title}第 ${image.index + 1} 张` : `放大${job.title}生成结果`} className="block w-full cursor-zoom-in overflow-hidden rounded-lg bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onPreview(image.imageUrl!)}>
                          <img src={image.imageUrl} alt={multiple ? `${job.summary}，第 ${image.index + 1} 张` : job.summary} className={multiple ? 'h-40 w-full object-contain' : 'max-h-[480px] w-full object-contain'} />
                        </button>
                        <Button variant="outline" size="sm" className="w-full" asChild><a href={image.imageUrl} download={`character-${job.id}-${image.index + 1}.png`}><DownloadIcon className="size-3.5" />下载</a></Button>
                      </>
                    ) : (
                      <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg bg-muted p-3 text-center text-xs text-muted-foreground">
                        {image.status === 'queued' ? <Clock3Icon className="size-5" /> : isBusy(image) ? <LoaderCircleIcon className="size-5 animate-spin" /> : <CircleAlertIcon className="size-5" />}
                        <p>{image.status === 'queued' ? '等待任务槽位或前一张完成' : image.progress?.message || statusText[image.status]}</p>
                        {image.error && <details className="w-full text-left"><summary className="cursor-pointer">查看详情</summary><p className="mt-2 max-h-32 overflow-y-auto break-words [overflow-wrap:anywhere]">{image.error}</p></details>}
                      </div>
                    )}
                    <GenerationTiming timing={image.startedAt === undefined ? null : { startedAt: image.startedAt, finishedAt: image.finishedAt ?? null }} isGenerating={image.status === 'preparing' || image.status === 'running'} isComfy={job.provider === 'comfyui'} />
                    {image.durationScope === 'tracking' && <p className="text-xs text-muted-foreground">耗时为本次恢复跟踪时长</p>}
                    {image.status === 'recoverable' && (
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" disabled={busy || !canResume(job.id, image.index)} onClick={() => onResume(job.id, image.index)}>恢复跟踪</Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild><Button size="sm" variant="outline" disabled={busy}>停止跟踪</Button></AlertDialogTrigger>
                          <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>停止跟踪此任务？</AlertDialogTitle><AlertDialogDescription>这会移除本地恢复记录，不会取消后端任务。请先核对 ComfyUI 队列，避免重复提交。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>保留记录</AlertDialogCancel><AlertDialogAction onClick={() => void onForget(job.id, image.index)}>停止跟踪</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </article>
          )
        })}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">任务独立使用提交时的配置。同一任务的图片依次生成，任意一张失败即停止后续生成；已完成图片分别保存到生成记录。切换页面可继续；刷新页面会中断云端跟踪，ComfyUI 已提交任务可恢复查询。</p>
    </div>
  )
}
