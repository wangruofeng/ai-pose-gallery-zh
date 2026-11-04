/** 全局以任务为单位限流；失败释放槽位，不阻塞其他任务。 */
export function createGenerationQueue(concurrency = 4) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('无效并发数')
  let active = 0
  const pending: (() => void)[] = []
  const drain = () => {
    while (active < concurrency && pending.length) pending.shift()!()
  }
  return {
    enqueue<T>(run: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        pending.push(() => {
          active++
          void Promise.resolve().then(run).then(resolve, reject).finally(() => { active--; drain() })
        })
        drain()
      })
    },
  }
}
