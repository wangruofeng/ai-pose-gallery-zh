import type { ComfyTaskHandle, GenerationProgress } from '@/services/aiGenerator'
import type { GenerationSnapshot, ImageProviderId } from './gallery'

export interface JobImage {
  index: number
  status: 'queued' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'recoverable' | 'interrupted'
  startedAt?: number
  finishedAt?: number
  imageUrl?: string
  error?: string
  progress?: GenerationProgress
  durationScope?: 'generation' | 'tracking'
}

export interface GenerationJob {
  id: string
  title: string
  createdAt: number
  provider: ImageProviderId
  model: string
  prompt: string
  summary: string
  images: JobImage[]
  snapshot?: GenerationSnapshot
}

export interface JobRecovery {
  job: Omit<GenerationJob, 'images'>
  count: number
  index: number
  task?: ComfyTaskHandle
  startedAt?: number
}
