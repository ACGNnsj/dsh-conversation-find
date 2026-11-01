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
`

    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /** The message flow's scroll container: nearest scrollable ancestor of a chat row. */
    function findFlow() {
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
      // Last resort: the generic scroll region, else the whole document. Searching
      // more than the chat is still better than silently finding nothing.
      if (!marker) {
        return (
          document.querySelector('[data-scroll-region]') ||
          document.querySelector('main') ||
          document.body
        )
      }
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

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG'])

    function collectTextNodes(root) {
      const out = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement
          if (!parent) return NodeFilter.FILTER_REJECT
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT
          if (parent.closest('mark[' + HIT_ATTR + ']')) return NodeFilter.FILTER_REJECT
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
      const flow = findFlow()
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
          const mod = event.ctrlKey || event.metaKey
          if (mod && event.shiftKey && (key === 'f' || key === 'F')) {
            event.preventDefault()
            event.stopPropagation()
            toggle()
            return
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
      }, [reset, toggle])

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
        const place = () => {
          let top = 56
          const flow = findFlow()
          if (flow && flow !== document.body) {
            const rect = flow.getBoundingClientRect()
            if (rect.top > 0) top = Math.round(rect.top) + 8
          }
          setTopPx(top)
        }
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
      }, [open, runSearch])

      useEffect(() => () => clearMarks(), [])

      if (!open) return null

      const empty = query.length > 0 && count === 0

      return React.createElement(
        'div',
        { className: 'dsh-cf-bar', role: 'search', 'aria-label': '在会话中查找', 'data-dsh-cf': 'bar', style: { top: topPx + 'px' } },
        React.createElement('input', {
          ref: inputRef,
          className: 'dsh-cf-input',
          type: 'text',
          value: query,
          placeholder: '在会话中查找',
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

    function FindButton() {
      return React.createElement(
        'button',
        {
          type: 'button',
          title: '在会话中查找（Ctrl+Shift+F）',
          'aria-label': '在会话中查找',
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
    }

    return { apply, inject: ['slots'] }
  }
})
