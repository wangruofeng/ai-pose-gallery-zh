import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { transformWithOxc } from 'vite'

// 受控时钟验证显示与 effect 生命周期，无网络请求。
const source = fs.readFileSync(new URL('../../src/components/studio/GenerationTiming.tsx', import.meta.url), 'utf8')
const { code } = await transformWithOxc(source, 'GenerationTiming.tsx', { jsx: { runtime: 'automatic' } })
let clock = 1000
let state
let dependencies
let cleanup
let tick
let cleared = 0
const jsx = (type, props) => ({ type, ...props })
const context = vm.createContext({
  Date: { now: () => clock },
  useState(initial) {
    state ??= initial()
    return [state, (value) => { state = value }]
  },
  useEffect(effect, next) {
    if (dependencies && next.every((value, i) => Object.is(value, dependencies[i]))) return
    cleanup?.()
    cleanup = effect()
    dependencies = next
  },
  window: {
    setInterval(callback) { tick = callback; return 1 },
    clearInterval() { tick = undefined; cleared++ },
  },
  Clock3Icon: 'clock', _jsx: jsx, _jsxs: jsx,
})
vm.runInContext(code.replace(/^import .*;\n/gm, '').replace('export function', 'function'), context)
const render = (timing, isGenerating = true) => JSON.stringify(context.GenerationTiming({ timing, isGenerating, isComfy: false }))
assert.equal(render(null, false), 'null')
assert.match(render(null), /正在准备参考图/)
assert.match(render({ startedAt: 1000, finishedAt: null }), /0.0/)
clock = 4500
tick()
assert.match(render({ startedAt: 1000, finishedAt: null }), /3.5/)
assert.match(render({ startedAt: 1000, finishedAt: 5000 }, false), /4.0/)
assert.equal(tick, undefined)
assert.equal(cleared, 1)
clock = 9000
assert.match(render({ startedAt: 1000, finishedAt: 5000 }, false), /4.0/)
render({ startedAt: 9000, finishedAt: null })
clock = 11000
tick()
assert.match(render({ startedAt: 9000, finishedAt: null }), /2.0/)
cleanup?.()
assert.equal(cleared, 2)
console.log('计时测试通过：准备、递增、结束保留、重新计时、卸载清理。')
