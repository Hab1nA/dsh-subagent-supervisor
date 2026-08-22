/**
 * dsh-subagent-supervisor — browser half.
 *
 * Registers the "子代理" tab in the conversation view ring
 * (`conversation.view`): a supervision panel for the CURRENT session's direct
 * subagents, powered by the official Remote API
 * (`api.subagents.list/history/prompt/interrupt`) plus one plugin endpoint
 * (`/plugins/dsh-subagent-supervisor/children-config`) that supplies each
 * child's SET model / reasoning / preset in a single request.
 *
 * Performance notes (v0.3):
 *  - list rows are memoized components (React.memo) so polling re-renders only
 *    changed rows; unchanged lists/configs are skipped via JSON comparison.
 *  - an in-flight guard prevents poll ticks from stacking requests.
 *  - history is cached per child and shown instantly on re-select; the
 *    transcript renders at most MAX_ROWS rows (older pages still load).
 *  - history polling only happens while the SELECTED child is running;
 *    list polling stops entirely when no child is running.
 *
 * Bundle format: `window.__ModuleLoader__.load({id, factory})` — the same
 * contract as every shipped client bundle (see dsh-client-auto-continue), so
 * this file doubles as the built artifact; no build step.
 *
 * @module dsh-subagent-supervisor/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-supervisor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    const name = 'dsh-subagent-supervisor'
    const inject = ['slots', 'connection']

    /* ---------- pure helpers (client-side mirror of the host logic) ---------- */

    function textOfBlocks(blocks) {
      if (!Array.isArray(blocks)) return ''
      return blocks
        .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    }

    function clip(text, maxChars) {
      if (typeof text !== 'string') return String(text ?? '')
      if (text.length <= maxChars) return text
      const head = Math.floor(maxChars * 0.6)
      const tail = maxChars - head - 3
      return text.slice(0, head) + '...' + text.slice(-tail)
    }

    function resultOf(response) {
      const result = response && response.result
      if (result && result.ok === true) return result.value
      const error = result && result.error
      throw new Error(error ? `${error.code}: ${error.message}` : 'rpc failed without a result')
    }

    function childOf(children, childId) {
      return (children || []).find((c) => String(c.id) === String(childId))
    }

    /** One transcript row from a HistoryEntry, or null when unrenderable. */
    function renderEntry(entry) {
      const ev = entry && entry.event
      if (!ev || typeof ev !== 'object') return null
      switch (ev.type) {
        case 'turn/start':
          return { kind: 'boundary', text: `turn ${ev.data.turn} start` }
        case 'turn/end': {
          const reason = ev.data.reason || {}
          let text = `turn ${ev.data.turn} end: ${reason.kind ?? 'unknown'}`
          if (reason.kind === 'error' && reason.error) text += ` (${reason.error.code ?? 'UNKNOWN'}: ${clip(String(reason.error.message ?? ''), 200)})`
          if (reason.kind === 'aborted' && reason.reason) text += ` (cause=${reason.reason.kind ?? 'unknown'})`
          return { kind: 'boundary', text }
        }
        case 'step/start':
          return { kind: 'boundary', text: `  step ${ev.data.step} start` }
        case 'step/end':
          return { kind: 'boundary', text: `  step ${ev.data.step} end` }
        case 'user/message': {
          const msg = ev.data
          const kind = msg.source && msg.source.kind ? msg.source.kind : 'user'
          return { kind: 'user', text: `user [${kind}]: ${clip(textOfBlocks(msg.content), 400)}` }
        }
        case 'assistant/message': {
          const msg = ev.data.message
          const blocks = Array.isArray(msg.content) ? msg.content : []
          const text = textOfBlocks(blocks)
          const reasoningLen = blocks.filter((b) => b.type === 'reasoning').reduce((n, b) => n + String(b.text || '').length, 0)
          const toolCalls = blocks.filter((b) => b.type === 'tool-call')
          let line = `assistant: ${clip(text, 400)}`
          if (reasoningLen > 0) line += `\n  reasoning: ${reasoningLen} chars`
          for (const tc of toolCalls) line += `\n  -> tool call ${tc.name}(${clip(tc.arguments, 200)})`
          return { kind: 'assistant', text: line }
        }
        case 'tool/result': {
          const msg = ev.data.message
          const err = ev.data.error
          const text = clip(textOfBlocks(msg && msg.content ? msg.content : []), 300)
          const flag = ev.data.isError !== undefined && ev.data.isError ? ' [error]' : err ? ` [error ${err.code ?? ''}]` : ''
          return { kind: 'tool', text: `  tool result${flag}: ${text}` }
        }
        default:
          return null
      }
    }

    /* ---------- styles ---------- */

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontFamily: 'var(--dsh-font, system-ui, sans-serif)', fontSize: 13 },
      bar: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--dsh-border, rgba(128,128,128,.25))' },
      title: { fontWeight: 600, marginRight: 'auto' },
      button: { padding: '3px 10px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'var(--dsh-button, rgba(128,128,128,.12))', cursor: 'pointer', fontSize: 12 },
      danger: { borderColor: 'rgba(220,80,80,.5)', color: 'var(--dsh-danger, #d05050)' },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      list: { width: 300, flex: 'none', overflowY: 'auto', borderRight: '1px solid var(--dsh-border, rgba(128,128,128,.25))', padding: 6 },
      row: { padding: '6px 8px', borderRadius: 6, cursor: 'pointer', marginBottom: 4, border: '1px solid transparent' },
      rowActive: { borderColor: 'var(--dsh-accent, rgba(80,120,220,.6))', background: 'var(--dsh-selected, rgba(80,120,220,.12))' },
      rowTitle: { fontWeight: 500, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
      badge: { fontSize: 11, padding: '1px 6px', borderRadius: 8, background: 'rgba(128,128,128,.15)' },
      badgeRunning: { background: 'rgba(80,180,90,.25)', color: 'var(--dsh-ok, #2f8f3f)' },
      meta: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 },
      tag: { fontSize: 10, padding: '0 5px', borderRadius: 6, background: 'rgba(128,128,128,.10)', color: 'var(--dsh-muted, rgba(128,128,128,.85))' },
      detail: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
      detailHead: { padding: '8px 12px', borderBottom: '1px solid var(--dsh-border, rgba(128,128,128,.25))' },
      transcript: { flex: 1, overflowY: 'auto', padding: '8px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--dsh-mono, ui-monospace, monospace)', fontSize: 12, lineHeight: 1.5 },
      empty: { color: 'var(--dsh-muted, rgba(128,128,128,.7))', padding: 12 },
      error: { color: 'var(--dsh-danger, #d05050)', padding: '6px 12px', background: 'rgba(220,80,80,.08)', borderBottom: '1px solid rgba(220,80,80,.25)' },
      actions: { display: 'flex', gap: 8, padding: '8px 12px', borderTop: '1px solid var(--dsh-border, rgba(128,128,128,.25))', alignItems: 'center' },
      input: { flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'var(--dsh-input, transparent)', color: 'inherit', fontSize: 12 },
    }

    /* ---------- memoized list row with the three config tags ---------- */

    function ChildRow(props) {
      const child = props.child
      const config = props.config
      const active = props.active
      const onSelect = props.onSelect
      if (child.kind !== 'child') {
        return React.createElement('div', { style: styles.row }, `[diagnostic: ${child.reason}]`)
      }
      const settings = (config && config.settings) || {}
      const preset = config ? config.preset : undefined
      // Effective (actual) model/reasoning from the endpoint: explicit override
      // wins, else the child's own header (live) or the parent's header
      // (inherited) — show the real value instead of a bare "继承" label.
      const effective = (config && config.effective) || {}
      const effModel = settings.model || effective.model || '继承'
      const effEffort = settings.reasoningEffort || effective.reasoningEffort || '继承'
      const badge = child.activity === 'running' ? { ...styles.badge, ...styles.badgeRunning } : styles.badge
      return React.createElement('div', {
        style: active ? { ...styles.row, ...styles.rowActive } : styles.row,
        onClick: () => onSelect(String(child.id)),
      },
        React.createElement('div', { style: styles.rowTitle },
          React.createElement('span', { style: badge }, child.activity === 'running' ? 'running' : 'inactive'),
          React.createElement('span', { style: badge }, child.mode),
          child.hasChildren ? React.createElement('span', { style: badge }, 'children') : null,
        ),
        React.createElement('div', null, child.label || String(child.id).slice(0, 12)),
        React.createElement('div', { style: styles.meta },
          React.createElement('span', { style: styles.tag }, `模型: ${effModel}`),
          React.createElement('span', { style: styles.tag }, `推理: ${effEffort}`),
          React.createElement('span', { style: styles.tag }, `预设: ${preset || '继承'}`),
        ),
        React.createElement('div', { style: { ...styles.empty, padding: 0, fontSize: 11 } }, String(child.id).slice(0, 8)),
      )
    }
    const MemoChildRow = React.memo(ChildRow)

    /* ---------- the panel component ---------- */

    const MAX_ROWS = 400
    const POLL_MS = 5000

    function SupervisorView(props) {
      const api = props.api
      const sessionId = props.sessionId
      const [children, setChildren] = React.useState(null)
      const [configMap, setConfigMap] = React.useState({})
      const [error, setError] = React.useState(null)
      const [info, setInfo] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [history, setHistory] = React.useState(null)
      const [hasMore, setHasMore] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const busyRef = React.useRef(false)
      const historyCache = React.useRef(new Map())

      const refreshList = React.useCallback(async (forceConfig) => {
        if (busyRef.current) return
        busyRef.current = true
        try {
          const catalog = resultOf(await api.subagents.list({ parentSessionId: sessionId }))
          setChildren((prev) => {
            const next = catalog.entries
            if (prev !== null && JSON.stringify(prev) === JSON.stringify(next)) return prev
            return next
          })
          // One extra request for the SET model/reasoning/preset per child.
          // The endpoint caches its durable catalog scan; the manual refresh
          // button bypasses that cache.
          try {
            const res = await fetch(`/plugins/dsh-subagent-supervisor/children-config?parent=${encodeURIComponent(sessionId)}${forceConfig ? '&fresh=1' : ''}`)
            if (res.ok) {
              const payload = await res.json()
              const map = {}
              for (const row of payload.children || []) map[row.id] = row
              setConfigMap((prev) => {
                if (Object.keys(prev).length === Object.keys(map).length && JSON.stringify(prev) === JSON.stringify(map)) return prev
                return map
              })
            }
          } catch { /* config labels are best-effort */ }
          setError(null)
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        } finally {
          busyRef.current = false
        }
      }, [api, sessionId])

      const loadHistory = React.useCallback(async (childId, before) => {
        const child = childOf(children, childId)
        if (!child || child.kind !== 'child') return
        if (busyRef.current) return
        busyRef.current = true
        try {
          const page = resultOf(await api.subagents.history({
            parentSessionId: sessionId,
            childSessionId: childId,
            mode: child.mode,
            ...(before ? { beforeSeq: before } : {}),
            maxMessages: 80,
          }))
          const cached = historyCache.current.get(childId)
          const merged = before ? [...(cached ? cached.entries : []), ...page.events] : page.events
          const bySeq = new Map()
          for (const entry of merged) {
            if (entry && entry.event && typeof entry.event.seq === 'number') bySeq.set(entry.event.seq, entry)
          }
          const sorted = [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq)
          historyCache.current.set(childId, { entries: sorted, hasMore: page.hasMore })
          setHistory(sorted)
          setHasMore(page.hasMore)
          setError(null)
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        } finally {
          busyRef.current = false
        }
      }, [api, sessionId, children])

      React.useEffect(() => {
        refreshList()
      }, [refreshList])

      // Poll: list always (cheap, guarded); history only while the SELECTED
      // child is running.
      React.useEffect(() => {
        const timer = setInterval(() => {
          refreshList()
          if (selected !== null) {
            const child = childOf(children, selected)
            if (child && child.activity === 'running') loadHistory(selected, null)
          }
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [refreshList, loadHistory, children, selected])

      // Selection: show the cache instantly, then refresh in the background.
      React.useEffect(() => {
        if (selected === null) {
          setHistory(null)
          setHasMore(false)
          return
        }
        const cached = historyCache.current.get(selected)
        if (cached) {
          setHistory(cached.entries)
          setHasMore(cached.hasMore)
        }
        loadHistory(selected, null)
      }, [selected, loadHistory])

      const onSelect = (childId) => setSelected((prev) => (prev === childId ? null : childId))
      const onSend = async () => {
        if (!draft.trim() || busy || selected === null) return
        const child = childOf(children, selected)
        if (!child || child.mode !== 'continuable') return
        setBusy(true)
        try {
          const zone = (typeof Intl !== 'undefined' && Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone) || undefined
          await api.subagents.prompt({
            parentSessionId: sessionId,
            childSessionId: selected,
            mode: 'continuable',
            content: [{ type: 'text', text: draft }],
            ...(zone ? { clientTimeZone: zone } : {}),
          })
          setDraft('')
          setInfo('message queued as the next FIFO turn')
          setError(null)
          refreshList()
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }
      const onInterrupt = async () => {
        if (busy || selected === null) return
        const child = childOf(children, selected)
        if (!child || child.mode !== 'continuable') return
        setBusy(true)
        try {
          await api.subagents.interrupt({
            parentSessionId: sessionId,
            childSessionId: selected,
            mode: 'continuable',
          })
          setInfo('interrupt requested; the child may keep running briefly')
          setError(null)
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }
      const onLoadOlder = () => {
        if (selected === null || !history || history.length === 0) return
        const oldest = history[0].event.seq
        loadHistory(selected, oldest)
      }

      const rows = (history || []).map(renderEntry).filter((r) => r !== null)
      const renderedRows = rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows
      const selectedChild = selected !== null ? childOf(children, selected) : undefined
      const selectedConfig = selected !== null ? configMap[selected] : undefined

      return React.createElement('div', { style: styles.wrap },
        React.createElement('div', { style: styles.bar },
          React.createElement('span', { style: styles.title }, '子代理监督'),
          React.createElement('button', { style: styles.button, onClick: () => refreshList(true) }, '刷新'),
        ),
        error ? React.createElement('div', { style: styles.error }, `错误: ${error}`) : null,
        info ? React.createElement('div', { style: { ...styles.empty, color: 'var(--dsh-ok, #2f8f3f)' } }, info) : null,
        React.createElement('div', { style: styles.body },
          React.createElement('div', { style: styles.list },
            !children
              ? React.createElement('div', { style: styles.empty }, '加载中…')
              : children.length === 0
                ? React.createElement('div', { style: styles.empty }, '(无子代理)')
                : children.map((child) => React.createElement(MemoChildRow, {
                    key: String(child.id),
                    child,
                    config: configMap[String(child.id)],
                    active: selected === String(child.id),
                    onSelect,
                  })),
          ),
          React.createElement('div', { style: styles.detail },
            selectedChild === undefined
              ? React.createElement('div', { style: styles.empty }, '选择左侧子代理查看逐步转写')
              : [
                  React.createElement('div', { key: 'head', style: styles.detailHead },
                    React.createElement('div', { style: styles.rowTitle },
                      React.createElement('span', { style: selectedChild.activity === 'running' ? { ...styles.badge, ...styles.badgeRunning } : styles.badge }, selectedChild.activity),
                      React.createElement('span', { style: styles.badge }, selectedChild.mode),
                    ),
                    React.createElement('div', { style: { marginTop: 2 } }, selectedChild.label || String(selectedChild.id)),
                    selectedConfig
                      ? React.createElement('div', { style: styles.meta },
                          React.createElement('span', { style: styles.tag }, `模型: ${selectedConfig.settings ? selectedConfig.settings.model || (selectedConfig.effective ? selectedConfig.effective.model : undefined) || '继承' : '继承'}`),
                          React.createElement('span', { style: styles.tag }, `推理: ${selectedConfig.settings ? selectedConfig.settings.reasoningEffort || (selectedConfig.effective ? selectedConfig.effective.reasoningEffort : undefined) || '继承' : '继承'}`),
                          React.createElement('span', { style: styles.tag }, `预设: ${selectedConfig.preset || '继承'}`),
                        )
                      : null,
                    React.createElement('div', { style: { ...styles.empty, padding: 0, fontSize: 11 } }, String(selectedChild.id)),
                  ),
                  React.createElement('div', { key: 'transcript', style: styles.transcript },
                    renderedRows.length === 0
                      ? React.createElement('span', { style: styles.empty }, '(转写为空或尚未加载)')
                      : renderedRows.map((row, i) => React.createElement('div', { key: i, style: { marginBottom: 2 } }, row.text)),
                  ),
                  hasMore
                    ? React.createElement('div', { key: 'more', style: { padding: '4px 12px' } },
                        React.createElement('button', { style: styles.button, onClick: onLoadOlder }, '加载更早'),
                      )
                    : null,
                  selectedChild.mode === 'continuable'
                    ? React.createElement('div', { key: 'actions', style: styles.actions },
                        React.createElement('input', {
                          style: styles.input,
                          value: draft,
                          placeholder: '发送消息（作为子代理的下一个回合）…',
                          onChange: (e) => setDraft(e.target.value),
                          onKeyDown: (e) => { if (e.key === 'Enter') onSend() },
                        }),
                        React.createElement('button', { style: styles.button, onClick: onSend, disabled: busy }, '发送'),
                        React.createElement('button', { style: { ...styles.button, ...styles.danger }, onClick: onInterrupt, disabled: busy }, '中断'),
                      )
                    : null,
                ],
          ),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register(
        {
          name: 'conversation.view',
          id: 'subagent-supervisor',
          order: 20,
          label: () => '子代理',
          inject: (sessionId) => ({ api: ctx.connection.api, sessionId }),
        },
        SupervisorView,
      ))
    }

    module.exports = { name, inject, apply }
    module.exports.default = { name, inject, apply }
    return module.exports
  },
})
