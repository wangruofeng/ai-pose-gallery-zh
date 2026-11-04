import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { transformWithOxc } from 'vite'

const compile = async path => (await transformWithOxc(fs.readFileSync(path, 'utf8'), path)).code.replace(/^import .*;\n/gm, '').replaceAll('export function', 'function')
const queueCode = await compile('src/lib/generationQueue.ts')
const hookCode = await compile('src/store/useGenerationJobs.ts')
const cells = []
const effects = []
let cursor = 0
let serial = 0
let live = 0
let maxLive = 0
const waiting = []
const calls = []
const saved = []
const storage = new Map()
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve() }
class ComfyTaskError extends Error {}
class ComfySubmissionRejectedError extends Error {}
const context = vm.createContext({
  console, structuredClone, AbortController, Date, Map, Set, Promise, Error,
  crypto: { randomUUID: () => `job-${++serial}` },
  toast: Object.assign(() => {}, { error: () => {} }),
  ComfyTaskError, ComfySubmissionRejectedError,
  useState(initial) {
    const index = cursor++
    if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
    return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
  },
  useRef(value) { const index = cursor++; return cells[index] ??= { current: value } },
  useEffect(effect) { const index = cursor++; if (!(index in cells)) { cells[index] = true; effects.push(effect) } },
  idbRead: async key => storage.get(key),
  idbWrite: async (key, value) => { storage.set(key, structuredClone(value)) },
  snapshotGeneration: async (recipe, config, prompt) => {
    const { providers, ...settings } = structuredClone(config)
    return { recipe: structuredClone(recipe), prompt, settings, models: Object.fromEntries(Object.entries(providers).map(([id, value]) => [id, { model: value.model }])) }
  },
  generateCharacterImage: async options => {
    options.onRequestStart()
    const provider = options.config.activeProvider
    calls.push({ prompt: options.prompt, model: options.config.providers[provider].model })
    if (provider === 'comfyui') {
      await options.onSubmitting()
      if (options.prompt === 'unknown') throw new Error('提交结果未知')
      await options.onSubmitted({ promptId: 'backend-task', baseUrl: 'local', submittedAt: Date.now() })
      if (options.prompt === 'resume') throw new Error('跟踪连接中断')
    }
    live++; maxLive = Math.max(maxLive, live)
    await new Promise(resolve => waiting.push(resolve))
    live--
    if (options.prompt === 'fail' || (options.prompt === 'fail-second' && calls.filter(item => item.prompt === 'fail-second').length === 2)) throw new Error('模拟单张失败')
    return { imageUrl: `data:image/png;base64,${options.prompt}`, providerUsed: provider, modelUsed: options.config.providers[provider].model }
  },
  resumeComfyTask: async () => ({ imageUrl: 'data:image/png;base64,recovered', providerUsed: 'comfyui', modelUsed: 'workflow' }),
})
vm.runInContext(queueCode + hookCode + '\nglobalThis.renderHook = save => useGenerationJobs(save)', context)
const saveImage = async (job, image, result, durationMs) => {
  saved.push({ taskId: job.id, index: image.index, prompt: job.prompt, model: result.modelUsed, durationMs })
  return result.imageUrl
}
const render = () => { cursor = 0; return context.renderHook(saveImage) }
render()
const cleanups = effects.map(effect => effect())
await flush()
let hook = render()
assert.equal(hook.ready, true)
const recipe = { portrait: { 发型名称: '原配方' }, extraImages: [] }
const config = { activeProvider: 'gpt', providers: { gpt: { model: 'model-a', apiKey: 'secret-test' }, comfyui: { model: 'workflow', apiKey: 'comfy-secret' } }, comfyuiParams: { timeoutSec: 60 } }
hook.submit(recipe, config, 'first', 4)
config.providers.gpt.model = 'model-b'
hook.submit(recipe, config, 'second', 2)
hook.submit(recipe, config, 'third', 1)
hook.submit(recipe, config, 'fourth', 1)
hook.submit(recipe, config, 'fifth', 1)
await flush()
assert.equal(live, 4)
assert.equal(calls.length, 4)
assert.equal(calls[0].model, 'model-a')
assert.equal(calls[1].model, 'model-b')
assert.equal(render().jobs.find(job => job.prompt === 'fifth').images[0].status, 'queued')
// 逐批放行请求，所有任务须各自完成且并发不超过四个。
for (let i = 0; i < 8; i++) { waiting.splice(0).forEach(resolve => resolve()); await flush() }
assert.equal(maxLive, 4)
assert.equal(saved.length, 9)
assert.equal(saved.filter(item => item.prompt === 'first').length, 4)
assert.ok(saved.every(item => item.durationMs >= 0))
hook = render()
hook.submit(recipe, config, 'fail', 2)
hook.submit(recipe, config, 'survives', 1)
for (let i = 0; i < 4; i++) { await flush(); waiting.splice(0).forEach(resolve => resolve()) }
await flush()
const failedJob = render().jobs.find(job => job.prompt === 'fail')
assert.equal(failedJob.images[0].status, 'failed')
assert.equal(failedJob.images[1].status, 'interrupted')
assert.equal(calls.filter(item => item.prompt === 'fail').length, 1)
assert.equal(saved.filter(item => item.prompt === 'survives').length, 1)
render().submit(recipe, config, 'fail-second', 3)
for (let i = 0; i < 5; i++) { await flush(); waiting.splice(0).forEach(resolve => resolve()) }
await flush()
const partiallyCompleted = render().jobs.find(job => job.prompt === 'fail-second')
assert.equal(partiallyCompleted.images[0].status, 'succeeded')
assert.equal(partiallyCompleted.images[1].status, 'failed')
assert.equal(partiallyCompleted.images[2].status, 'interrupted')
assert.equal(calls.filter(item => item.prompt === 'fail-second').length, 2)
assert.equal(saved.filter(item => item.prompt === 'fail-second').length, 1)
const before = calls.length
hook.submit(recipe, config, 'invalid', 5)
await flush()
assert.equal(calls.length, before)
config.activeProvider = 'comfyui'
render().submit(recipe, config, 'unknown', 3)
await flush()
const unknown = render().jobs.find(job => job.prompt === 'unknown')
assert.equal(unknown.images[0].status, 'recoverable')
assert.ok(unknown.images.slice(1).every(image => image.status === 'interrupted'))
assert.equal(calls.filter(item => item.prompt === 'unknown').length, 1)
assert.ok(!JSON.stringify([...storage.values()]).includes('secret'))
assert.equal(render().canResume(unknown.id, 0), false)
await render().forget(unknown.id, 0)
assert.equal(Object.keys([...storage.values()][0]).length, 0)
render().submit(recipe, config, 'resume', 2)
await flush()
const recoverable = render().jobs.find(job => job.prompt === 'resume')
assert.equal(render().canResume(recoverable.id, 0), true)
// 模拟页面刷新，恢复记录只能查询原任务，不能重新调用生成接口。
cleanups.forEach(cleanup => cleanup?.())
cells.length = 0
effects.length = 0
render()
const restoredCleanups = effects.map(effect => effect())
await flush()
assert.equal(render().jobs.find(job => job.id === recoverable.id).images[0].status, 'recoverable')
const requestCount = calls.length
render().resume(recoverable.id, 0, config)
await flush()
assert.equal(calls.length, requestCount)
assert.equal(render().jobs.find(job => job.id === recoverable.id).images[0].status, 'succeeded')
assert.equal(saved.at(-1).taskId, recoverable.id)
restoredCleanups.forEach(cleanup => cleanup?.())
console.log('通过：四任务并发、任务内 1–4 张、配置快照、独立耗时、失败停止后续图片且不影响其他任务、数量校验、ComfyUI 未决暂停及无密钥恢复记录。')
