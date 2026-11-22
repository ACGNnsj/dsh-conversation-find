import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const between = (start, end) => {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, `Missing source boundary: ${start}`)
  return source.slice(from, to)
}
const run = (code, context = {}) => vm.runInNewContext(code, { assert, useCallback: f => f, ...context })
const search = between('    let marks =', '    function paint()') + between('      const runSearch =', '      const step =')
function engine(count, check) {
  const text = { nodeType: 3, nodeValue: typeof count === 'string' ? count : 'hit' }
  const nodes = typeof count === 'string' ? [text] : Array(count).fill(text)
  run(search + check, {
    MAX_HITS: 2000, HIT_ATTR: 'data-cf-hit', Node: { TEXT_NODE: 3 }, findScope: () => ({}),
    collectTextNodes: () => nodes, ensureStyle() {}, paint() {},
    document: { createRange: () => ({ setStart(n, at) { this.text = n.nodeValue; assert.ok(at >= 0 && at <= this.text.length) }, setEnd(n, at) { assert.ok(at >= 0 && at <= this.text.length) }, surroundContents() {} }), createElement: () => ({ setAttribute() {} }) },
    setCount() {}, setPosition() {}, setOverflow() {}, observerRef: { current: null },
  })
}
test('same-order streamed rescan keeps the active hit', () => {
  engine(3, `highlight('hit'); currentIndex = 2; runSearch('hit', { keepPosition: true, scroll: false }); assert.equal(currentIndex, 2)`)
})
test('exact count versus overflow', () => {
  engine(2000, `assert.equal(highlight('hit').length, 2000); assert.equal(typeof hitOverflow !== 'undefined' && hitOverflow, false)`)
  engine(2001, `assert.equal(highlight('hit').length, 2000); assert.equal(typeof hitOverflow !== 'undefined' && hitOverflow, true)`)
})
test('Unicode case folding cannot produce an out-of-bounds range', () => {
  engine('İX', `assert.equal(highlight('x').length, 1)`)
})
test('header Find refocuses an open bar instead of closing it', () => {
  assert.ok(source.includes('window.addEventListener(OPEN_EVENT, onOpenEvent)'))
  assert.ok(between('    function FindButton()', '    function apply(').includes('new CustomEvent(OPEN_EVENT)'))
})
const keyEffect = between('        const onKeyDown =', '        const onToggleEvent =')
const inputKey = between('          onKeyDown: (event)', '\n        }),').trim().replace('onKeyDown: ', '')
test('repeated Find from outside the bar refocuses instead of closing', () => {
  run(`let focused = 0, toggled = 0; const toggle = () => toggled++; const inputRef = { current: { focus() { focused++ }, select() {} } };\n` + keyEffect + `onKeyDown(event); assert.equal(focused, 1); assert.equal(toggled, 0)`, {
    event: { key: 'f', preventDefault() {}, stopPropagation() {} },
    isOpenChord: () => true, openRef: { current: true },
  })
})
test('IME Enter and Escape do not navigate or dismiss', () => {
  run(`let actions = 0; const step = () => actions++; const reset = step; const close = step;\n` + keyEffect + `\nconst field = ${inputKey}; onKeyDown(event); field({ ...event, key: 'Enter' }); assert.equal(actions, 0)`, {
    event: { key: 'Escape', isComposing: true, nativeEvent: { isComposing: true, keyCode: 229 }, preventDefault() {}, stopPropagation() {} },
    isOpenChord: () => false, openRef: { current: true },
  })
})
test('clearing the query removes its saved value', () => {
  run(between('    function savePageQuery(', '    /**\n     * Does this') + `pageQueries = { A: 'alpha' }; savePageQuery('A', ''); assert.equal('A' in pageQueries, false)`, {
    PAGE_QUERY_LIMIT: 50,
    window: { localStorage: { setItem() {} } },
  })
})
const observer = between('        const onMutations =', '        const observer = new MutationObserver')
const syncStart = source.includes('      const syncPage =') ? between('      const syncPage =', '      // Style once') : ''
const fixture = `let sid = 'A', restored = '', pending = []; const root = {}; const ref = current => ({ current });
const scopeRef = ref(root), pendingScopeRef = ref(null), openRef = ref(true), observerTimer = ref(0), searchTimer = ref(0), queryOwnerRef = ref('A'), queryRef = ref('alpha');
const findScope = () => root, pageKey = () => sid, measureTop = () => 0, setTopPx = () => {}, getOnSwitch = () => 'keep', setQuery = q => restored = q, loadPageQuery = k => k === 'B' ? 'beta' : 'alpha', runSearch = () => {}, close = () => {}, reset = close;
const lastApplyAt = 0, Date = { now: () => 100 }, Node = { ELEMENT_NODE: 1 };
const window = { clearTimeout() {}, setTimeout(fn) { pending.push(fn); return pending.length } };
const records = [{ target: { nodeType: 1, closest: () => null } }];\n`
test('same-root navigation restores destination query', () => {
  run(fixture + syncStart + observer + `sid = 'B'; onMutations(records); assert.equal(restored, 'beta'); assert.equal(queryOwnerRef.current, 'B')`)
})
test('a final mutation shortly after searching still schedules a refresh', () => {
  run(fixture + syncStart + observer + `onMutations(records); assert.equal(pending.length, 1)`)
})
