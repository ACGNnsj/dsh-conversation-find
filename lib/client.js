/* global window, document, getComputedStyle, NodeFilter, MutationObserver, Node, CustomEvent */
/**
 * dsh-conversation-find — client half.
 *
 * A browser-like find bar for the CURRENT conversation:
 *   Ctrl/Cmd+Shift+F  toggle the bar
 *   Enter / Shift+Enter  next / previous hit
 *   Esc  close
 *
 * How it works: the chat history is ordinary DOM, so this searches the text
 * nodes of the chat flow container and wraps each hit in <mark>. Navigation
 * scrolls the current hit into view. No chat-store subscription is involved,
 * which is why it also finds text inside tool output, diffs and code blocks.
 *
 * Known limitation (reported in the UI): only text that is currently mounted in
 * the flow is searchable. When the conversation pages/virtualizes older turns,
 * hits inside unmounted rows are not counted.
 *
 * Registered entries:
 *   - shell.overlay (root scope)          → the find bar
 *   - conversation.session.header.utilities (session scope) → a toggle button
 */
window.__ModuleLoader__.load({
  id: 'dsh-conversation-find',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    // Host UI primitives (Menu + icons) come from the web shell, exactly as the
    // built-in Settings rows do. They are optional: if the module is missing the
    // preference row degrades to a native <select>.
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }

    const BAR_ENTRY_ID = 'conversation-find:bar'
    const BUTTON_ENTRY_ID = 'conversation-find:button'
    const STYLE_ID = 'dsh-conversation-find-style'
    const HIT_ATTR = 'data-cf-hit'
    const CURRENT_ATTR = 'data-cf-current'
    const TOGGLE_EVENT = 'dsh-conversation-find:toggle'
    const MAX_HITS = 2000

    const CSS = `
.dsh-cf-bar {
  pointer-events: auto;
  position: fixed;
  top: 56px;
  right: 26px;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  background: rgba(28, 28, 31, 0.94);
  color: #e9e9ec;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.32);
  font: 13px/1.35 var(--dsh-font-ui, system-ui, -apple-system, "Segoe UI", sans-serif);
  backdrop-filter: blur(8px);
}
.dsh-cf-input {
  width: 210px;
  padding: 4px 6px;
  border: none;
  outline: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  font: inherit;
}
.dsh-cf-input::placeholder { color: rgba(233, 233, 236, 0.45); }
.dsh-cf-count {
  min-width: 52px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: rgba(233, 233, 236, 0.7);
}
.dsh-cf-count[data-empty="true"] { color: #ff9f7a; }
.dsh-cf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.dsh-cf-btn:hover { background: rgba(255, 255, 255, 0.12); }
.dsh-cf-btn[disabled] { opacity: 0.35; cursor: default; }
.dsh-cf-hint {
  position: fixed;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 60;
  pointer-events: none;
  padding: 6px 12px;
  border-radius: 8px;
  background: rgba(28, 28, 31, 0.94);
  color: #e9e9ec;
  font: 12px/1.4 var(--dsh-font-ui, system-ui, sans-serif);
}
mark.dsh-cf-hit {
  background: rgba(250, 204, 21, 0.42);
  color: inherit;
  border-radius: 2px;
  padding: 0;
}
mark.dsh-cf-hit[data-cf-current="true"] {
  background: #ffab2e;
  color: #1b1b1d;
  outline: 1px solid #ffab2e;
  box-shadow: 0 0 0 2px rgba(255, 171, 46, 0.35);
}
/* Settings row: matches the host's own General rows (title, muted caption,
   trailing pill). Colours come from the live theme tokens, so light/dark both
   work without a second stylesheet. */
.dsh-cf-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  width: 100%;
  box-sizing: border-box;
  border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.2));
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-cf-row-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 4px;
  min-width: 0;
  padding-right: 48px;
}
.dsh-cf-row-title {
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
}
.dsh-cf-row-desc {
  color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9));
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
}
.dsh-cf-pill {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  flex: 0 0 auto;
  max-width: 320px;
  height: 36px;
  padding: 0 14px;
  appearance: none;
  -webkit-appearance: none;
  border: none;
  box-shadow: none;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-module-platform, #353638);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-cf-pill:hover { background: var(--dsw-alias-interactive-bg-hover, #3f4145); }
.dsh-cf-pill-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-cf-pill-chevron {
  flex: none;
}
`

    // ---- shortcut preference (client-side, survives a reload) --------------
    const PREF_KEY = 'dsh-conversation-find:shortcut'
    const PREF_OPTIONS = [
      { value: 'auto', label: '自动' },
      { value: 'ctrl-f', label: 'Ctrl+F' },
      { value: 'ctrl-shift-f', label: 'Ctrl+Shift+F' },
      { value: 'alt-f', label: 'Alt+F' },
      { value: 'f3', label: 'F3' }
    ]
    let pref = 'auto'
    const prefListeners = new Set()
    try {
      const saved = window.localStorage.getItem(PREF_KEY)
      if (saved && PREF_OPTIONS.some((option) => option.value === saved)) pref = saved
    } catch {
      /* storage unavailable */
    }
    function getPref() {
      return pref
    }
    function setPref(next) {
      if (!PREF_OPTIONS.some((option) => option.value === next)) return
      pref = next
      try {
        window.localStorage.setItem(PREF_KEY, next)
      } catch {
        /* ignore */
      }
      for (const listener of prefListeners) {
        try {
          listener(next)
        } catch {
          /* ignore */
        }
      }
    }
    function subscribePref(listener) {
      prefListeners.add(listener)
      return () => prefListeners.delete(listener)
    }

    // ---- search-scope preference (client-side, survives a reload) -----------
    const SCOPE_KEY = 'dsh-conversation-find:scope'
    const SCOPE_OPTIONS = [
      { value: 'content', label: '正文区' },
      { value: 'page', label: '整页（含侧栏）' }
    ]
    let scope = 'content'
    const scopeListeners = new Set()
    try {
      const savedScope = window.localStorage.getItem(SCOPE_KEY)
      if (savedScope && SCOPE_OPTIONS.some((option) => option.value === savedScope)) scope = savedScope
    } catch {
      /* storage unavailable */
    }
    function getScope() {
      return scope
    }
    function setScope(next) {
      if (!SCOPE_OPTIONS.some((option) => option.value === next)) return
      scope = next
      try {
        window.localStorage.setItem(SCOPE_KEY, next)
      } catch {
        /* ignore */
      }
      for (const listener of scopeListeners) {
        try {
          listener(next)
        } catch {
          /* ignore */
        }
      }
    }
    function subscribeScope(listener) {
      scopeListeners.add(listener)
      return () => scopeListeners.delete(listener)
    }

    // ---- page-switch preference: close the bar, or keep it and follow the layout
    const CLOSE_KEY = 'dsh-conversation-find:on-switch'
    const CLOSE_OPTIONS = [
      { value: 'close', label: '关闭查找条' },
      { value: 'keep', label: '保留查找条' }
    ]
    let onSwitch = 'close'
    const closeListeners = new Set()
    try {
      const savedClose = window.localStorage.getItem(CLOSE_KEY)
      if (savedClose && CLOSE_OPTIONS.some((option) => option.value === savedClose)) onSwitch = savedClose
    } catch {
      /* storage unavailable */
    }
    function getOnSwitch() {
      return onSwitch
    }
    function setOnSwitch(next) {
      if (!CLOSE_OPTIONS.some((option) => option.value === next)) return
      onSwitch = next
      try {
        window.localStorage.setItem(CLOSE_KEY, next)
      } catch {
        /* ignore */
      }
      for (const listener of closeListeners) {
        try {
          listener(next)
        } catch {
          /* ignore */
        }
      }
    }
    function subscribeOnSwitch(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    }
    /**
     * Does this keydown open the find bar under the current preference?
     * `auto` listens to every chord that the shell might leave alone, which is
     * the degrade path: if the host menu swallows Ctrl+F before the page ever
     * sees it, Ctrl+Shift+F / Alt+F still arrive here.
     */
    function isOpenChord(event) {
      const key = (event.key || '').toLowerCase()
      if (key !== 'f') return false
      const ctrl = event.ctrlKey || event.metaKey
      if (pref === 'ctrl-f') return ctrl && !event.shiftKey && !event.altKey
      if (pref === 'ctrl-shift-f') return ctrl && !!event.shiftKey
      if (pref === 'alt-f') return !!event.altKey && !ctrl
      if (pref === 'f3') return false
      return ctrl || !!event.altKey
    }

    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head) return
      const existing = document.getElementById(STYLE_ID)
      if (existing) {
        // The renderer hot-reloads client plugins without reloading the page, so
        // a <style> tag from a previous module instance can survive a CSS edit.
        // Keep it in sync instead of trusting the first insertion.
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /** The message flow's scroll container: nearest scrollable ancestor of a chat row. */
    function findChatFlow() {
      if (typeof document === 'undefined') return null
      const markers = ['[data-chat-flow]', '[data-chat-flow-kind]', '[data-chat-node-key]', '[data-chat-anchor-key]']
      let marker = null
      for (const selector of markers) {
        try {
          marker = document.querySelector(selector)
        } catch {
          marker = null
        }
        if (marker) break
      }
      if (!marker) return null
      let el = marker
      while (el && el !== document.documentElement) {
        let style
        try {
          style = getComputedStyle(el)
        } catch {
          style = null
        }
        if (style && /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 8) return el
        el = el.parentElement
      }
      return marker.parentElement || marker
    }

    /**
     * The session sidebar column, so 「正文区」 can leave it out on routes that
     * have no chat flow (settings, plugin pages, market …).
     *
     * The shell frame is the grid parent of the bottom row (always rendered);
     * its columns are plain divs with hashed class names and the sidebar
     * attribute only appears while collapsed, so the leading column is found by
     * geometry: flush with the frame's left edge, full height, narrower than
     * half the frame. That skips the centred content, the full-width overlay
     * layer and the bottom row.
     */
    function findSidebarColumn() {
      if (typeof document === 'undefined') return null
      const anchor = document.querySelector('[data-shell-bottom],[data-shell-overlay]')
      const frame = anchor && anchor.parentElement
      if (!frame) return null
      let box
      try {
        box = frame.getBoundingClientRect()
      } catch {
        return null
      }
      if (!box || !box.height || !box.width) return null
      let best = null
      for (const el of frame.children) {
        let rect
        try {
          rect = el.getBoundingClientRect()
        } catch {
          continue
        }
        if (rect.width <= 0 || rect.width >= box.width * 0.5) continue
        if (rect.height < box.height * 0.8) continue
        if (Math.abs(rect.left - box.left) > 1) continue
        if (!best || rect.width < best.rect.width) best = { el, rect }
      }
      return best ? best.el : null
    }

    /**
     * What this search covers, which depends on where the user is:
     *   conversation → the chat flow only (clean counts, no sidebar noise)
     *   any other route (settings, plugin pages, market …) → the whole document,
     *   exactly like the browser's own find
     */
    function findScope() {
      if (typeof document === 'undefined') return null
      if (getScope() === 'page') return document.body
      const chatFlow = findChatFlow()
      if (chatFlow) return chatFlow
      return document.body
    }

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG'])

    function collectTextNodes(root) {
      const out = []
      // One geometry probe per search: on non-chat routes the root is the whole
      // document, so the sidebar column has to be carved out separately.
      const sidebar = getScope() === 'page' ? null : findSidebarColumn()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement
          if (!parent) return NodeFilter.FILTER_REJECT
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT
          // Never search inside editable regions: the composer is a contenteditable,
          // and wrapping its text nodes in <mark> makes the editor drop the typed text.
          if (parent.isContentEditable) return NodeFilter.FILTER_REJECT
          if (parent.closest('[contenteditable],[role="textbox"]')) return NodeFilter.FILTER_REJECT
          // The composer input renders <p> children and is not caught by tag or
          // contenteditable checks alone (attribute set via property). Skip the
          // whole composer subtree by its stable data attributes.
          if (parent.closest('[data-composer-input],[data-composer-seat],[data-composer-dock],[data-composer-overlay],[data-composer-card],[data-composer-composing]')) return NodeFilter.FILTER_REJECT
          // Same rule on every route: 「正文区」 means "not the session sidebar".
          if (sidebar && sidebar.contains(parent)) return NodeFilter.FILTER_REJECT
          // Default scope leaves the session list and page chrome out; 「整页」 keeps them.
          if (getScope() !== 'page' && parent.closest('aside,nav,[role="navigation"],[role="complementary"]')) return NodeFilter.FILTER_REJECT
          if (parent.closest('mark[' + HIT_ATTR + ']')) return NodeFilter.FILTER_REJECT
          // Never search the find bar itself.
          if (parent.closest('.dsh-cf-bar')) return NodeFilter.FILTER_REJECT
          const text = node.nodeValue
          if (!text || !text.trim()) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        }
      })
      let node = walker.nextNode()
      while (node) {
        out.push(node)
        node = walker.nextNode()
      }
      return out
    }

    /** Current hit elements, in document order. */
    let marks = []
    let currentIndex = -1
    let lastApplyAt = 0

    function clearMarks() {
      for (const mark of marks) {
        const parent = mark.parentNode
        if (!parent) continue
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
        try {
          parent.normalize()
        } catch {
          /* ignore */
        }
      }
      marks = []
      currentIndex = -1
    }

    function highlight(query) {
      clearMarks()
      lastApplyAt = Date.now()
      const flow = findScope()
      if (!flow || !query) return []
      const needle = query.toLowerCase()
      const found = []
      for (const start of collectTextNodes(flow)) {
        let cursor = start
        let from = 0
        while (cursor && cursor.nodeType === Node.TEXT_NODE && found.length < MAX_HITS) {
          const text = cursor.nodeValue || ''
          const at = text.toLowerCase().indexOf(needle, from)
          if (at === -1) break
          const range = document.createRange()
          range.setStart(cursor, at)
          range.setEnd(cursor, at + needle.length)
          const mark = document.createElement('mark')
          mark.className = 'dsh-cf-hit'
          mark.setAttribute(HIT_ATTR, '')
          try {
            range.surroundContents(mark)
          } catch {
            from = at + needle.length
            continue
          }
          found.push(mark)
          const next = mark.nextSibling
          cursor = next && next.nodeType === Node.TEXT_NODE ? next : null
          from = 0
        }
      }
      marks = found
      return marks
    }

    function paint() {
      for (let i = 0; i < marks.length; i += 1) {
        if (i === currentIndex) marks[i].setAttribute(CURRENT_ATTR, 'true')
        else marks[i].removeAttribute(CURRENT_ATTR)
      }
    }

    function scrollToCurrent() {
      const mark = marks[currentIndex]
      if (!mark) return
      try {
        mark.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
      } catch {
        /* older engines */
      }
    }

    /**
     * Where the bar sits: just under the measured top edge of the current scope,
     * so it lands below the host's own divider instead of a guessed constant.
     */
    function measureTop() {
      let top = 56
      const target = findScope()
      if (target && target !== document.body) {
        const rect = target.getBoundingClientRect()
        if (rect.top > 0) top = Math.round(rect.top) + 8
      }
      return top
    }

    function FindBar() {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [count, setCount] = useState(0)
      const [position, setPosition] = useState(0)
      const [topPx, setTopPx] = useState(56)
      const openRef = useRef(false)
      const queryRef = useRef('')
      const inputRef = useRef(null)
      const searchTimer = useRef(0)
      const observerTimer = useRef(0)
      const observerRef = useRef(null)
      const scopeRef = useRef(null)
      const pendingScopeRef = useRef(null)

      openRef.current = open
      queryRef.current = query

      const runSearch = useCallback((raw, options) => {
        const opts = options || {}
        ensureStyle()
        const list = highlight(raw)
        lastApplyAt = Date.now()
        if (!list.length) {
          setCount(0)
          setPosition(0)
          return
        }
        currentIndex = opts.keepPosition ? Math.min(Math.max(currentIndex, 0), list.length - 1) : 0
        paint()
        setCount(list.length)
        setPosition(currentIndex + 1)
        if (opts.scroll !== false) scrollToCurrent()
        if (observerRef.current) {
          try {
            observerRef.current.takeRecords()
          } catch {
            /* ignore */
          }
        }
      }, [])

      const step = useCallback((delta) => {
        if (!marks.length) return
        currentIndex = (currentIndex + delta + marks.length) % marks.length
        paint()
        setPosition(currentIndex + 1)
        scrollToCurrent()
      }, [])

      const close = useCallback(() => {
        setOpen(false)
        setQuery('')
        setCount(0)
        setPosition(0)
        clearMarks()
      }, [])

      // Style once, even while closed (the header button uses the same tokens).
      useEffect(() => {
        ensureStyle()
      }, [])

      // Global shortcuts: Ctrl/Cmd+Shift+F toggles, Esc closes while open.
      const reset = useCallback(() => {
        clearMarks()
        setOpen(false)
        setQuery('')
        setCount(0)
        setPosition(0)
      }, [])

      const toggle = useCallback(() => {
        if (openRef.current) {
          reset()
          return
        }
        setOpen(true)
      }, [reset])

      useEffect(() => {
        const onKeyDown = (event) => {
          const key = event.key
          if (isOpenChord(event)) {
            event.preventDefault()
            event.stopPropagation()
            // Ctrl+F while already typing in the bar should re-focus the field,
            // not close the bar the user is working in.
            const target = event.target
            const insideBar =
              target && target.nodeType === Node.ELEMENT_NODE ? !!target.closest('.dsh-cf-bar') : false
            if (insideBar && inputRef.current) {
              inputRef.current.focus()
              inputRef.current.select()
              return
            }
            toggle()
            return
          }
          if (key === 'F3' || key === 'f3') {
            // Browser muscle memory: F3 opens (when nothing else does) or steps.
            if (openRef.current) {
              event.preventDefault()
              event.stopPropagation()
              step(event.shiftKey ? -1 : 1)
              return
            }
            if (getPref() === 'auto' || getPref() === 'f3') {
              event.preventDefault()
              event.stopPropagation()
              setOpen(true)
              return
            }
          }
          if (key === 'Escape' && openRef.current) {
            event.preventDefault()
            event.stopPropagation()
            reset()
          }
        }
        const onToggleEvent = () => toggle()
        window.addEventListener('keydown', onKeyDown, true)
        window.addEventListener(TOGGLE_EVENT, onToggleEvent)
        return () => {
          window.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener(TOGGLE_EVENT, onToggleEvent)
        }
      }, [reset, step, toggle])

      // Focus the input whenever the bar opens.
      useEffect(() => {
        if (!open) return
        const id = window.setTimeout(() => {
          const input = inputRef.current
          if (!input) return
          input.focus()
          input.select()
        }, 0)
        return () => window.clearTimeout(id)
      }, [open])

      // Sit BELOW the session header divider: measure where the chat flow starts
      // instead of hard-coding a header height the app owns.
      useEffect(() => {
        if (!open) return
        scopeRef.current = findScope()
        pendingScopeRef.current = null
        const place = () => setTopPx(measureTop())
        place()
        const id = window.setTimeout(place, 80)
        window.addEventListener('resize', place)
        return () => {
          window.clearTimeout(id)
          window.removeEventListener('resize', place)
        }
      }, [open])

      // Debounced incremental search.
      useEffect(() => {
        if (!open) return
        window.clearTimeout(searchTimer.current)
        searchTimer.current = window.setTimeout(() => {
          runSearch(query, { scroll: false })
        }, 120)
        return () => window.clearTimeout(searchTimer.current)
      }, [open, query, runSearch])

      // Keep highlights alive across React re-renders and streamed tokens.
      useEffect(() => {
        if (!open) return
        const onMutations = (records) => {
          if (!openRef.current) return
          // A different search root means the tab / page changed. The host keeps
          // the URL stable across its own navigation, so DOM identity is the only
          // signal; require the new root twice in a row so a transient re-render
          // is not mistaken for a page switch.
          const scopeNow = findScope()
          if (scopeNow !== scopeRef.current) {
            if (pendingScopeRef.current !== scopeNow) {
              pendingScopeRef.current = scopeNow
              setTopPx(measureTop())
              return
            }
            pendingScopeRef.current = null
            scopeRef.current = scopeNow
            if (getOnSwitch() === 'close') {
              reset()
              return
            }
            setTopPx(measureTop())
            window.clearTimeout(observerTimer.current)
            observerTimer.current = window.setTimeout(() => {
              runSearch(queryRef.current, { keepPosition: false, scroll: false })
            }, 250)
            return
          }
          pendingScopeRef.current = null
          // Layout can move without a page switch (panel opens, header wraps).
          setTopPx(measureTop())
          const onlyOurOwn = records.every((record) => {
            const target = record.target
            if (!target) return true
            const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement
            if (!el) return true
            return !!(el.closest && el.closest('.dsh-cf-bar'))
          })
          if (onlyOurOwn) return
          if (Date.now() - lastApplyAt < 400) return
          window.clearTimeout(observerTimer.current)
          observerTimer.current = window.setTimeout(() => {
            runSearch(queryRef.current, { keepPosition: true, scroll: false })
          }, 250)
        }
        const observer = new MutationObserver(onMutations)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        observerRef.current = observer
        return () => {
          observer.disconnect()
          observerRef.current = null
          window.clearTimeout(observerTimer.current)
        }
      }, [open, reset, runSearch])

      // History navigation also counts as a page switch.
      useEffect(() => {
        if (!open) return
        const onNavigate = () => {
          scopeRef.current = findScope()
          pendingScopeRef.current = null
          if (getOnSwitch() === 'close') {
            reset()
            return
          }
          setTopPx(measureTop())
        }
        window.addEventListener('popstate', onNavigate)
        window.addEventListener('hashchange', onNavigate)
        return () => {
          window.removeEventListener('popstate', onNavigate)
          window.removeEventListener('hashchange', onNavigate)
        }
      }, [open, reset])

      useEffect(() => () => clearMarks(), [])

      if (!open) return null

      const empty = query.length > 0 && count === 0

      return React.createElement(
        'div',
        { className: 'dsh-cf-bar', role: 'search', 'aria-label': '在页面中查找', 'data-dsh-cf': 'bar', style: { top: topPx + 'px' } },
        React.createElement('input', {
          ref: inputRef,
          className: 'dsh-cf-input',
          type: 'text',
          value: query,
          placeholder: '查找',
          spellCheck: false,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              step(event.shiftKey ? -1 : 1)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
          }
        }),
        React.createElement(
          'span',
          { className: 'dsh-cf-count', 'data-empty': empty ? 'true' : undefined },
          query.length > 0 ? (count > 0 ? position + '/' + count : '无结果') : '—'
        ),
        React.createElement(
          'button',
          {
            className: 'dsh-cf-btn',
            type: 'button',
            title: '上一个（Shift+Enter）',
            'aria-label': '上一个',
            disabled: count === 0,
            onClick: () => step(-1)
          },
          React.createElement(
            'svg',
            { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
            React.createElement('path', { d: 'M4 10l4-4 4 4' })
          )
        ),
        React.createElement(
          'button',
          {
            className: 'dsh-cf-btn',
            type: 'button',
            title: '下一个（Enter）',
            'aria-label': '下一个',
            disabled: count === 0,
            onClick: () => step(1)
          },
          React.createElement(
            'svg',
            { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
            React.createElement('path', { d: 'M4 6l4 4 4-4' })
          )
        ),
        React.createElement(
          'button',
          {
            className: 'dsh-cf-btn',
            type: 'button',
            title: '关闭（Esc）',
            'aria-label': '关闭',
            onClick: close
          },
          React.createElement(
            'svg',
            { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 },
            React.createElement('path', { d: 'M4 4l8 8M12 4l-8 8' })
          )
        )
      )
    }

    /**
     * The preference row in Settings → General. This slot projects no label and
     * passes no props: the row draws its own title, control and help text.
     */
    function PrefRow(config) {
      const [value, setValue] = useState(config.read())
      const [open, setOpen] = useState(false)
      useEffect(() => config.subscribe(setValue), [])
      useEffect(() => {
        ensureStyle()
      }, [])

      const options = config.options
      const current = options.find((option) => option.value === value) || options[0]
      const menu = primitives && primitives.Menu ? primitives.Menu : null
      const Chevron = primitives && primitives.IconChevronDownOutlineRegular
        ? primitives.IconChevronDownOutlineRegular
        : null

      const chevron = Chevron
        ? React.createElement(Chevron, { className: 'dsh-cf-pill-chevron' })
        : React.createElement(
            'svg',
            {
              className: 'dsh-cf-pill-chevron',
              width: 14,
              height: 14,
              viewBox: '0 0 14 14',
              'aria-hidden': 'true'
            },
            React.createElement('path', {
              d: 'M3.2 5.2L7 9L10.8 5.2',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinecap: 'round',
              strokeLinejoin: 'round'
            })
          )

      const trigger = React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-cf-pill',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-label': config.label + '：' + current.label,
          onClick: () => setOpen((previous) => !previous)
        },
        React.createElement('span', { className: 'dsh-cf-pill-label' }, current.label),
        chevron
      )

      const control = menu
        ? React.createElement(menu, {
            open,
            onClose: () => setOpen(false),
            items: options.map((option) => ({ id: option.value, label: option.label })),
            selectedId: value,
            onSelect: (id) => {
              setOpen(false)
              config.write(id)
            },
            align: 'end',
            portal: true,
            anchor: trigger
          })
        : React.createElement(
            'select',
            {
              className: 'dsh-cf-pill',
              value,
              'aria-label': config.label,
              onChange: (event) => config.write(event.target.value)
            },
            options.map((option) =>
              React.createElement('option', { key: option.value, value: option.value }, option.label)
            )
          )

      return React.createElement(
        'div',
        { className: 'dsh-cf-row', 'data-dsh-cf': 'settings-row' },
        React.createElement(
          'div',
          { className: 'dsh-cf-row-main' },
          React.createElement('div', { className: 'dsh-cf-row-title' }, config.title),
          React.createElement(
            'div',
            { className: 'dsh-cf-row-desc' },
            config.desc
          )
        ),
        control
      )
    }

    const ShortcutRow = () =>
      PrefRow({
        title: '页面查找快捷键',
        desc: '打开页面内的浮层查找条（Ctrl+F 式搜索）。「自动」会同时监听三个组合，宿主抢先吞掉 Ctrl+F 时另外两个仍能打开。',
        label: '页面查找快捷键',
        options: PREF_OPTIONS,
        read: getPref,
        write: setPref,
        subscribe: subscribePref
      })

    const ScopeRow = () =>
      PrefRow({
        title: '页面查找范围',
        desc: '「正文区」跳过左侧会话列表和导航，只搜当前页面主体；「整页」像浏览器一样连侧栏一起搜。',
        label: '页面查找范围',
        options: SCOPE_OPTIONS,
        read: getScope,
        write: setScope,
        subscribe: subscribeScope
      })

    const SwitchRow = () =>
      PrefRow({
        title: '切换页面时',
        desc: '换标签页、或打开设置 / 插件市场等新页面时：默认收起查找条；选「保留查找条」会留在新页面上重新搜一遍，并跟着新布局移动位置。',
        label: '切换页面时',
        options: CLOSE_OPTIONS,
        read: getOnSwitch,
        write: setOnSwitch,
        subscribe: subscribeOnSwitch
      })

    function FindButton() {
      return React.createElement(
        'button',
        {
          type: 'button',
          title: '查找（Ctrl+F）',
          'aria-label': '查找',
          'data-dsh-cf': 'toggle',
          className: 'dsh-cf-btn',
          style: { width: 26, height: 26 },
          onClick: () => {
            try {
              window.dispatchEvent(new CustomEvent(TOGGLE_EVENT))
            } catch {
              /* ignore */
            }
          }
        },
        React.createElement(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
          React.createElement('circle', { cx: 7, cy: 7, r: 4.2 }),
          React.createElement('path', { d: 'M10.2 10.2L14 14' })
        )
      )
    }

    function apply(ctx) {
      try {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: BAR_ENTRY_ID,
              order: 30,
              registrant: 'dsh-conversation-find'
            },
            FindBar
          )
        )
      } catch (error) {
        console.error('[conversation-find] overlay registration failed', error)
      }
      try {
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: BUTTON_ENTRY_ID,
              order: 40,
              registrant: 'dsh-conversation-find'
            },
            FindButton
          )
        )
      } catch (error) {
        console.error('[conversation-find] header button registration failed', error)
      }
      try {
        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'conversation-find',
              order: 18,
              registrant: 'dsh-conversation-find'
            },
            ShortcutRow
          )
        )
      } catch (error) {
        console.error('[conversation-find] settings row registration failed', error)
      }
      try {
        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'conversation-find-scope',
              order: 19,
              registrant: 'dsh-conversation-find'
            },
            ScopeRow
          )
        )
      } catch (error) {
        console.error('[conversation-find] scope row registration failed', error)
      }
      try {
        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'conversation-find-switch',
              order: 20,
              registrant: 'dsh-conversation-find'
            },
            SwitchRow
          )
        )
      } catch (error) {
        console.error('[conversation-find] switch row registration failed', error)
      }
    }

    return { apply, inject: ['slots'] }
  }
})
