import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { createGenerationQueue } from '@/lib/generationQueue'
import { snapshotGeneration } from '@/lib/generationSnapshot'
import { idbRead, idbWrite } from '@/lib/idbStorage'
import { ComfySubmissionRejectedError, ComfyTaskError, generateCharacterImage, resumeComfyTask } from '@/services/aiGenerator'
import type { ApiConfig, RecipeState } from '@/types/gallery'
import type { GenerationJob, JobImage, JobRecovery } from '@/types/generationJob'

type Result = Awaited<ReturnType<typeof generateCharacterImage>>
type SaveImage = (job: GenerationJob, image: JobImage, result: Result, durationMs?: number) => Promise<string>
const RECOVERY_KEY = 'pose_atlas_job_recovery_v1'
const busyImage = (image: JobImage) => ['queued', 'preparing', 'running'].includes(image.status)

export function useGenerationJobs(saveImage: SaveImage) {
  const [jobs, setJobs] = useState<GenerationJob[]>([])
  const jobsRef = useRef(jobs)
  const [ready, setReady] = useState(false)
  const recovery = useRef<Record<string, JobRecovery>>({})
  const writes = useRef(Promise.resolve())
  const queue = useRef(createGenerationQueue(4))
  const controllers = useRef(new Set<AbortController>())
  const busyJobs = useRef(new Set<string>())
  const sequence = useRef(0)
  const mountedRef = useRef(true)
  const update = (fn: (current: GenerationJob[]) => GenerationJob[]) => {
    jobsRef.current = fn(jobsRef.current)
    setJobs(jobsRef.current)
  }
  const patch = (id: string, index: number, value: Partial<JobImage>) => update(current => current.map(job => job.id === id
    ? { ...job, images: job.images.map(image => image.index === index ? { ...image, ...value } : image) } : job))
  const checkpoint = (key: string, value?: JobRecovery) => {
    if (value) recovery.current[key] = value
    else delete recovery.current[key]
    const snapshot = structuredClone(recovery.current)
    const write = writes.current.catch(() => {}).then(() => idbWrite(RECOVERY_KEY, snapshot))
    writes.current = write
    return write
  }

  useEffect(() => {
    let mounted = true
    const activeControllers = controllers.current
    mountedRef.current = true
    void idbRead<Record<string, JobRecovery>>(RECOVERY_KEY).then(saved => {
      if (!mounted) return
      recovery.current = saved || {}
      const restored = new Map<string, GenerationJob>()
      for (const record of Object.values(saved || {})) {
        let job = restored.get(record.job.id)
        if (!job) {
          job = { ...record.job, images: Array.from({ length: record.count }, (_, index) => ({ index, status: 'interrupted', error: '页面刷新后未继续提交，请查看生成记录；不会自动重发请求。' })) }
          restored.set(job.id, job)
        }
        job.images[record.index] = { index: record.index, status: 'recoverable', startedAt: record.startedAt, finishedAt: Date.now(), error: record.task ? '后端任务已提交，可恢复跟踪。' : '提交结果未知，请先核对后端队列，勿重复提交。' }
      }
      update(() => [...restored.values()])
      sequence.current = restored.size
      setReady(true)
    }).catch(() => { if (mounted) toast.error('无法读取多任务恢复记录，已暂停提交，请检查浏览器存储后刷新。') })
    return () => { mounted = false; mountedRef.current = false; for (const controller of activeControllers) controller.abort() }
  }, [])

  const submit = (recipe: RecipeState, config: ApiConfig, prompt: string, count: number) => {
    if (!ready) return
    if (!Number.isInteger(count) || count < 1 || count > 4) { toast.error('每个任务可生成 1–4 张图片'); return }
    const recipeCopy = structuredClone(recipe)
    const configCopy = structuredClone(config)
    const providerConfig = configCopy.providers[configCopy.activeProvider]
    if (configCopy.activeProvider !== 'comfyui' && !providerConfig.apiKey.trim()) { toast.error('请先配置当前接口的 API Key'); return }
    const model = providerConfig.model === 'custom' ? providerConfig.customModel.trim() : providerConfig.model
    if (!model) { toast.error('请选择或填写模型 ID'); return }
    const job: GenerationJob = {
      id: crypto.randomUUID(), title: `任务 ${++sequence.current}`, createdAt: Date.now(), provider: configCopy.activeProvider,
      model, prompt, summary: [recipeCopy.portrait?.发型名称, recipeCopy.costume?.服装名称, recipeCopy.pose?.姿势名称].filter(Boolean).join(' + ') || '自定义合成',
      images: Array.from({ length: count }, (_, index) => ({ index, status: 'queued' })),
    }
    update(current => [job, ...current])
    busyJobs.current.add(job.id)
    void queue.current.enqueue(async () => {
      if (!mountedRef.current) { busyJobs.current.delete(job.id); return }
      const controller = new AbortController()
      controllers.current.add(controller)
      try {
        // 每个任务单独冻结参考图与参数；其中的多张图片顺序请求，不占用额外任务槽位。
        patch(job.id, 0, { status: 'preparing' })
        const snapshot = await snapshotGeneration(recipeCopy, configCopy, prompt)
        job.snapshot = snapshot
        update(current => current.map(item => item.id === job.id ? { ...item, snapshot } : item))
        for (let index = 0; index < count; index++) {
          controller.signal.throwIfAborted()
          patch(job.id, index, { status: 'preparing' })
          const key = `${job.id}:${index}`
          let startedAt: number | undefined
          let finishedAt: number | undefined
          let preparedSnapshot = snapshot
          try {
            const result = await generateCharacterImage({
              recipe: snapshot.recipe, config: configCopy, prompt, signal: controller.signal,
              onRequestStart: () => { startedAt = Date.now(); patch(job.id, index, { status: 'running', startedAt }) },
              onProgress: progress => patch(job.id, index, { progress }),
              onSubmitting: async prepared => {
                preparedSnapshot = { ...snapshot, submittedWorkflowJson: prepared ? JSON.stringify(prepared.workflow) : undefined }
                await checkpoint(key, { job: { ...job, snapshot: preparedSnapshot }, count, index, startedAt })
              },
              onSubmitted: task => checkpoint(key, { job: { ...job, snapshot: preparedSnapshot }, count, index, task, startedAt }),
            })
            finishedAt = Date.now()
            controller.signal.throwIfAborted()
            patch(job.id, index, { imageUrl: result.imageUrl, finishedAt })
            const image: JobImage = { index, status: 'succeeded', startedAt, finishedAt }
            const imageUrl = await saveImage({ ...job, snapshot: preparedSnapshot }, image, result, startedAt === undefined ? undefined : finishedAt - startedAt)
            patch(job.id, index, { ...image, imageUrl })
            if (job.provider === 'comfyui') await checkpoint(key)
          } catch (error) {
            const rejected = error instanceof ComfySubmissionRejectedError || (error instanceof ComfyTaskError && error.reason === 'failed')
            if (rejected && recovery.current[key]) await checkpoint(key)
            const unresolved = Boolean(recovery.current[key])
            const message = error instanceof Error ? error.message : '生成失败'
            patch(job.id, index, { status: unresolved ? 'recoverable' : 'failed', error: message, startedAt, finishedAt: finishedAt ?? Date.now() })
            const stoppedReason = unresolved
              ? '前一张的后端状态尚未确认，已停止后续生成。'
              : `第 ${index + 1} 张生成失败，已停止后续生成。`
            for (let next = index + 1; next < count; next++) patch(job.id, next, { status: 'interrupted', error: stoppedReason })
            break
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '任务准备失败'
        update(current => current.map(item => item.id === job.id ? { ...item, images: item.images.map(image => busyImage(image) ? { ...image, status: 'failed', error: message } : image) } : item))
      } finally {
        controllers.current.delete(controller)
        busyJobs.current.delete(job.id)
        const current = jobsRef.current.find(item => item.id === job.id)
        const completed = current?.images.filter(image => image.status === 'succeeded').length || 0
        if (mountedRef.current) toast(completed === count ? `${job.title}：${count} 张已生成并保存` : `${job.title}：已完成 ${completed}/${count} 张，请查看各张状态`)
      }
    }).catch(() => toast.error('任务执行异常，请查看任务详情'))
  }

  const resume = (jobId: string, index: number, config: ApiConfig) => {
    const key = `${jobId}:${index}`
    const record = recovery.current[key]
    if (!record?.task || busyJobs.current.has(jobId)) return
    const task = record.task
    const apiKey = config.providers.comfyui.apiKey
    const timeoutSec = config.comfyuiParams.timeoutSec
    busyJobs.current.add(jobId)
    patch(jobId, index, { status: 'queued', error: undefined })
    void queue.current.enqueue(async () => {
      if (!mountedRef.current) { busyJobs.current.delete(jobId); return }
      const controller = new AbortController()
      controllers.current.add(controller)
      const startedAt = Date.now()
      patch(jobId, index, { status: 'running', startedAt, finishedAt: undefined, durationScope: 'tracking' })
      try {
        const result = await resumeComfyTask({ task, apiKey, timeoutSec, signal: controller.signal, onProgress: progress => patch(jobId, index, { progress }) })
        const finishedAt = Date.now()
        controller.signal.throwIfAborted()
        const job = jobsRef.current.find(item => item.id === jobId)!
        const image: JobImage = { index, status: 'succeeded', startedAt, finishedAt, durationScope: 'tracking' }
        const imageUrl = await saveImage(job, image, result, finishedAt - startedAt)
        patch(jobId, index, { ...image, imageUrl })
        await checkpoint(key)
      } catch (error) {
        const rejected = error instanceof ComfyTaskError && error.reason === 'failed'
        if (rejected) await checkpoint(key)
        patch(jobId, index, { status: rejected ? 'failed' : 'recoverable', error: error instanceof Error ? error.message : '恢复跟踪失败', finishedAt: Date.now() })
      } finally { controllers.current.delete(controller); busyJobs.current.delete(jobId) }
    }).catch(error => {
      patch(jobId, index, { status: 'recoverable', error: error instanceof Error ? error.message : '无法保存恢复记录', finishedAt: Date.now() })
    })
  }

  const forget = async (jobId: string, index: number) => {
    if (busyJobs.current.has(jobId)) return
    try { await checkpoint(`${jobId}:${index}`); patch(jobId, index, { status: 'interrupted', error: '已停止跟踪，后端任务可能仍在执行。' }) }
    catch { toast.error('恢复记录清除失败，请检查浏览器存储') }
  }
  const canResume = (jobId: string, index: number) => Boolean(recovery.current[`${jobId}:${index}`]?.task)
  return { jobs, ready, submit, resume, forget, canResume }
}
