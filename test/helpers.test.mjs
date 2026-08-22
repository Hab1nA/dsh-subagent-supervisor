/**
 * Unit tests for the pure helpers of dsh-subagent-supervisor.
 *
 * These helpers carry the contract the host-plane tools depend on:
 *  - clip: bounded head/tail truncation of model-facing text.
 *  - textOfBlocks / textLengthOf: text extraction from content block arrays.
 *  - mergeOverrides: per-child override merging (only non-empty, typed fields).
 *  - foldPendingInbox: durable agent/inbox/spliced reconstruction of pending
 *    next-turn / next-step lists (the cold-child queue view).
 *  - queueRowOf: compact queue row projection.
 *
 * Run from the harness root:  node --test plugins/dsh-subagent-supervisor/test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clip,
  textOfBlocks,
  textLengthOf,
  mergeOverrides,
  foldPendingInbox,
  queueRowOf,
  selectEventWindow,
  definedOnly,
  validateEffortAgainstModelInfo,
  resolveEffectiveRoute,
  parseOverridesFile,
  serializeOverridesFile,
  resolveOverridesFilePath,
  classifySettlement,
  terminalReasonOf,
  finalOutputOf,
  settlementSummaryOf,
  trimSettled,
  registerWaiter,
  resolveWaiters,
  buildChildrenConfig,
  mergeColdChildren,
  resolveSendMode,
  resolveColdPreset,
  inheritRouteFromHeader,
  resolveEffectiveDisplay,
} from '../lib/index.js'

test('clip truncates long text with head/tail and keeps short text intact', () => {
  const long = 'a'.repeat(200)
  const out = clip(long, 100)
  assert.equal(out.length, 100)
  assert.ok(out.startsWith('a'.repeat(60)), 'keeps the head')
  assert.ok(out.endsWith('a'.repeat(37)), 'keeps the tail')
  assert.ok(out.includes('...'), 'marks the cut')
  assert.equal(clip('short', 100), 'short')
  assert.equal(clip(undefined, 100), '')
  assert.equal(clip(null, 100), '')
  assert.equal(clip(42, 100), '42')
})

test('textOfBlocks concatenates only text blocks, ignoring other block types', () => {
  const blocks = [
    { type: 'text', text: 'hello ' },
    { type: 'reasoning', text: 'secret reasoning' },
    { type: 'text', text: 'world' },
    { type: 'tool-call', name: 'x', arguments: '{}', id: 'c1' },
    null,
    { type: 'text' },
  ]
  assert.equal(textOfBlocks(blocks), 'hello world')
  assert.equal(textOfBlocks([]), '')
  assert.equal(textOfBlocks(undefined), '')
})

test('textLengthOf counts only text-block length', () => {
  const blocks = [
    { type: 'text', text: 'abc' },
    { type: 'reasoning', text: 'xyz' },
  ]
  assert.equal(textLengthOf(blocks), 3)
  assert.equal(textLengthOf([]), 0)
})

test('mergeOverrides fills only non-empty, type-valid fields and preserves existing', () => {
  const existing = { model: 'm1', maxTokens: 100 }
  const merged = mergeOverrides(existing, {
    model: 'm2',
    reasoningEffort: 'high',
    temperature: 0.7,
    maxTokens: 512,
  })
  assert.deepEqual(merged, { model: 'm2', maxTokens: 512, reasoningEffort: 'high', temperature: 0.7 })

  // empty / invalid values are ignored, existing values survive
  const merged2 = mergeOverrides(existing, { model: '', reasoningEffort: '', temperature: Number.NaN, maxTokens: 0 })
  assert.deepEqual(merged2, existing)

  // undefined -> no new entry
  assert.deepEqual(mergeOverrides(undefined, {}), {})

  // temperature must be finite; provider/model only non-empty strings
  assert.deepEqual(mergeOverrides(undefined, { temperature: Infinity }), {})
  assert.deepEqual(mergeOverrides(undefined, { provider: 'p' }), { provider: 'p' })
})

test('foldPendingInbox reconstructs pending lists from durable splices', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } }, // ignored
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'a' }, { id: 'b' }] },
    },
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 's1' }] },
    },
    // claiming two next-turn messages: removed without outcome
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, removedCount: 2, inserted: [] },
    },
    // one cancelled message dropped from next-step
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
    },
  ]
  const state = foldPendingInbox(events)
  assert.deepEqual(state['next-turn'].map((m) => m.id), [])
  assert.deepEqual(state['next-step'].map((m) => m.id), [])
  // splices can also insert replacements mid-list
  const events2 = [
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'a' }, { id: 'b' }] },
    },
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 1, removedCount: 1, inserted: [{ id: 'c' }] },
    },
  ]
  const state2 = foldPendingInbox(events2)
  assert.deepEqual(state2['next-turn'].map((m) => m.id), ['a', 'c'])
  assert.deepEqual(state2['next-step'], [])
})

test('queueRowOf projects a compact queue row with clipped text', () => {
  const message = { id: 'msg-1', content: [{ type: 'text', text: 'x'.repeat(500) }] }
  const row = queueRowOf(message, 2, 'next-turn', 100)
  assert.equal(row.list, 'next-turn')
  assert.equal(row.index, 2)
  assert.equal(row.messageId, 'msg-1')
  assert.equal(row.text.length, 100)
})

test('selectEventWindow ignores streaming noise when counting the window', () => {
  // Heavy streaming: thousands of assistant/chunk events at the tail must not
  // crowd out the meaningful events (turn boundaries, messages, tool results).
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'u1' } },
    { type: 'assistant/message', data: { turn: 1, step: 1 } },
    { type: 'tool/result', data: { turn: 1, step: 1 } },
  ]
  for (let i = 0; i < 2000; i++) events.push({ type: 'assistant/chunk', data: { turn: 1, step: 1 } })
  events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const window = selectEventWindow(events, { limit: 100 })
  const types = window.map((ev) => ev.type)
  assert.ok(types.includes('turn/start'), 'keeps the oldest meaningful event within a small limit')
  assert.ok(types.includes('turn/end'), 'keeps the newest meaningful event')
  assert.ok(types.includes('assistant/message') && types.includes('tool/result'))
  assert.ok(!types.includes('assistant/chunk'), 'chunks are dropped from the window')
  assert.ok(window.length <= 100, 'window respects the limit in meaningful events')

  // since_turn keeps only events of that turn or later, still ignoring chunks.
  const events2 = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'u1' } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { id: 'u2' } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const window2 = selectEventWindow(events2, { sinceTurn: 2 })
  assert.ok(window2.every((ev) => !(ev.type === 'turn/start' && ev.data.turn < 2)))
  assert.equal(window2.filter((ev) => ev.type === 'user/message').length, 1)

  // Empty input yields an empty window.
  assert.deepEqual(selectEventWindow([], { limit: 10 }), [])
})

test('definedOnly strips undefined-valued keys so tool results stay lossless JSON', () => {
  const out = definedOnly({
    a: 'x',
    b: undefined,
    c: null,
    d: 0,
    e: false,
    nested: { keep: 1, drop: undefined },
  })
  assert.deepEqual(out, { a: 'x', c: null, d: 0, e: false, nested: { keep: 1, drop: undefined } })
  assert.ok(!('b' in out), 'undefined top-level key is removed')
  // The harness lossless-JSON validator rejects undefined values; after
  // definedOnly, JSON.stringify must not need to drop anything at the top level.
  const re = JSON.parse(JSON.stringify(out))
  assert.equal(re.a, 'x')
  assert.equal(re.c, null)
  assert.equal(re.d, 0)
  assert.equal(re.e, false)
  assert.deepEqual(re.nested, { keep: 1 })
})

/* ------------------------------------------------------------------ *
 * Phase A: reasoningEffort pre-validation
 * ------------------------------------------------------------------ */

test('validateEffortAgainstModelInfo accepts supported efforts', () => {
  const info = {
    provider: 'p',
    id: 'm',
    name: 'M',
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
      defaultEffort: 'medium',
    },
  }
  assert.deepEqual(validateEffortAgainstModelInfo('high', info), { ok: true })
  assert.deepEqual(validateEffortAgainstModelInfo('medium', info), { ok: true })
})

test('validateEffortAgainstModelInfo rejects unsupported efforts with the supported list', () => {
  const info = {
    provider: 'p',
    id: 'm',
    name: 'M',
    reasoning: { efforts: [{ id: 'high', name: 'High' }] },
  }
  const verdict = validateEffortAgainstModelInfo('medium', info)
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.supported, ['high'])
  // comparison is exact and case-sensitive (opaque adapter ids)
  assert.equal(validateEffortAgainstModelInfo('HIGH', info).ok, false)
})

test('validateEffortAgainstModelInfo passes through when the adapter exposes no efforts', () => {
  assert.deepEqual(validateEffortAgainstModelInfo('high', {}), { ok: true, skipped: true })
  assert.deepEqual(validateEffortAgainstModelInfo('high', { reasoning: undefined }), { ok: true, skipped: true })
  assert.deepEqual(validateEffortAgainstModelInfo('high', { reasoning: { efforts: undefined } }), { ok: true, skipped: true })
  assert.deepEqual(validateEffortAgainstModelInfo(undefined, { reasoning: { efforts: [] } }), { ok: true, skipped: true })
})

test('resolveEffectiveRoute resolves per-field with args > overrides > parent', () => {
  const parent = { provider: 'parent-prov', model: 'parent-model' }
  // args win over everything
  assert.deepEqual(
    resolveEffectiveRoute({ provider: 'arg-prov', model: 'arg-model' }, parent, {}),
    { provider: 'arg-prov', model: 'arg-model' },
  )
  // per-field fallback: args provider + overrides model + parent for the rest
  assert.deepEqual(
    resolveEffectiveRoute({ provider: 'arg-prov' }, parent, { model: 'ov-model' }),
    { provider: 'arg-prov', model: 'ov-model' },
  )
  // overrides beat parent
  assert.deepEqual(resolveEffectiveRoute({}, parent, { provider: 'ov-prov', model: 'ov-model' }), { provider: 'ov-prov', model: 'ov-model' })
  // nothing provided -> parent route
  assert.deepEqual(resolveEffectiveRoute({}, parent, {}), { provider: 'parent-prov', model: 'parent-model' })
  // undefined parent fields stay undefined (caller then skips validation)
  assert.deepEqual(resolveEffectiveRoute({}, {}, {}), { provider: undefined, model: undefined })
})

/* ------------------------------------------------------------------ *
 * Phase B: override registry persistence
 * ------------------------------------------------------------------ */

test('parseOverridesFile tolerates missing, invalid, and malformed files', () => {
  assert.equal(parseOverridesFile(undefined), null)
  assert.equal(parseOverridesFile(''), null)
  assert.equal(parseOverridesFile('not json'), null)
  assert.equal(parseOverridesFile('{"version":1}'), null) // no entries
  assert.equal(parseOverridesFile('{"version":1,"entries":[]}'), null) // entries not an object
  const parsed = parseOverridesFile(JSON.stringify({
    version: 1,
    entries: {
      child1: { model: 'm1', temperature: 0.4, updatedAt: 123 },
      child2: { reasoningEffort: 'high' },
    },
  }))
  assert.ok(parsed !== null)
  assert.equal(parsed.child1.model, 'm1')
  assert.equal(parsed.child1.temperature, 0.4)
  assert.equal(parsed.child2.reasoningEffort, 'high')
  // non-object entries are dropped
  const parsed2 = parseOverridesFile(JSON.stringify({ version: 1, entries: { bad: 'x', good: { model: 'm' } } }))
  assert.ok(parsed2 !== null)
  assert.ok(!('bad' in parsed2))
  assert.equal(parsed2.good.model, 'm')
})

test('serializeOverridesFile round-trips and stamps updatedAt', () => {
  const text = serializeOverridesFile({ child1: { model: 'm1', temperature: 0.4 } })
  const obj = JSON.parse(text)
  assert.equal(obj.version, 1)
  assert.equal(obj.entries.child1.model, 'm1')
  assert.equal(obj.entries.child1.temperature, 0.4)
  assert.equal(typeof obj.entries.child1.updatedAt, 'number')
  // unknown version rejected on read
  assert.equal(parseOverridesFile('{"version":2,"entries":{}}'), null)
})

test('agentPreset rides the override registry and persistence round-trip', () => {
  // mergeOverrides reads the tool-schema key (snake_case agent_preset) and
  // writes only non-empty string presets
  assert.deepEqual(mergeOverrides(undefined, { agent_preset: 'code' }), { agentPreset: 'code' })
  assert.deepEqual(mergeOverrides(undefined, { agent_preset: '' }), {})
  assert.deepEqual(mergeOverrides({ model: 'm1' }, { agent_preset: 'minimal' }), { model: 'm1', agentPreset: 'minimal' })
  // camelCase key is NOT read (the tool schema declares agent_preset)
  assert.deepEqual(mergeOverrides(undefined, { agentPreset: 'code' }), {})
  // parse accepts a string agentPreset and drops non-string values
  const parsed = parseOverridesFile(JSON.stringify({
    version: 1,
    entries: {
      good: { agentPreset: 'bohrium-solver', model: 'm' },
      bad: { agentPreset: 42 },
    },
  }))
  assert.ok(parsed !== null)
  assert.equal(parsed.good.agentPreset, 'bohrium-solver')
  assert.ok(!('bad' in parsed), 'entry with only an invalid agentPreset is dropped entirely')
  // serialize round-trips the field
  const round = parseOverridesFile(serializeOverridesFile({ child1: { agentPreset: 'code', reasoningEffort: 'high' } }))
  assert.ok(round !== null)
  assert.equal(round.child1.agentPreset, 'code')
  assert.equal(round.child1.reasoningEffort, 'high')
  // legacy files without the field still parse
  const legacy = parseOverridesFile(JSON.stringify({ version: 1, entries: { c: { model: 'm' } } }))
  assert.ok(legacy !== null)
  assert.ok(!('agentPreset' in legacy.c))
})

test('resolveOverridesFilePath honors DSH_HOME with tilde expansion and defaults to ~/.dsh', () => {
  const a = resolveOverridesFilePath(undefined)
  const b = resolveOverridesFilePath(undefined)
  assert.equal(a, b, 'deterministic for the same environment')
  assert.ok(a.endsWith('overrides.json') && a.includes('subagent-supervisor'), `expected a home-relative path, got ${a}`)
  const explicit = resolveOverridesFilePath('C:/home')
  assert.ok(explicit.startsWith('C:'), `keeps the provided home prefix, got ${explicit}`)
  assert.ok(explicit.includes('subagent-supervisor') && explicit.endsWith('overrides.json'), `appends the file path, got ${explicit}`)
  const tilde = resolveOverridesFilePath('~/custom-dsh')
  assert.ok(tilde.endsWith('overrides.json') && tilde.includes('subagent-supervisor'), `tilde expands, got ${tilde}`)
  assert.ok(!tilde.startsWith('~'), 'tilde is expanded')
})

/* ------------------------------------------------------------------ *
 * Phase E: settlement closure helpers
 * ------------------------------------------------------------------ */

test('classifySettlement decides settled/active/queued/unknown from the log tail', () => {
  const turn = (n, type) => ({ type: `turn/${type}`, data: { turn: n } })
  const step = (s) => ({ type: 'step/start', data: { step: s } })

  // no turn events at all -> unknown
  assert.equal(classifySettlement([], { nextTurn: 0, nextStep: 0 }), 'unknown')
  assert.equal(classifySettlement([{ type: 'user/message', data: { id: 'u1' } }], { nextTurn: 0, nextStep: 0 }), 'unknown')

  // a completed turn with an empty queue -> settled
  const settledLog = [turn(1, 'start'), step(1), turn(1, 'end')]
  assert.equal(classifySettlement(settledLog, { nextTurn: 0, nextStep: 0 }), 'settled')

  // pending queue work after a completed turn -> queued
  assert.equal(classifySettlement(settledLog, { nextTurn: 1, nextStep: 0 }), 'queued')
  assert.equal(classifySettlement(settledLog, { nextTurn: 0, nextStep: 1 }), 'queued')

  // an open turn -> active regardless of queue
  const activeLog = [turn(1, 'start'), step(1)]
  assert.equal(classifySettlement(activeLog, { nextTurn: 0, nextStep: 0 }), 'active')
  assert.equal(classifySettlement(activeLog, { nextTurn: 2, nextStep: 0 }), 'active')

  // a new turn after a completed one -> active
  const resumed = [turn(1, 'start'), turn(1, 'end'), turn(2, 'start')]
  assert.equal(classifySettlement(resumed, { nextTurn: 0, nextStep: 0 }), 'active')

  // an aborted/error turn still settles
  const aborted = [turn(1, 'start'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } }]
  assert.equal(classifySettlement(aborted, { nextTurn: 0, nextStep: 0 }), 'settled')
})

test('terminalReasonOf extracts the last turn-end reason kind from the log', () => {
  const start = (n) => ({ type: 'turn/start', data: { turn: n } })
  const end = (n, kind) => ({ type: 'turn/end', data: { turn: n, reason: { kind } } })
  assert.equal(terminalReasonOf([]), undefined)
  assert.equal(terminalReasonOf([start(1)]), undefined)
  assert.equal(terminalReasonOf([start(1), end(1, 'completed')]), 'completed')
  assert.equal(terminalReasonOf([start(1), end(1, 'interrupted')]), 'interrupted')
  assert.equal(terminalReasonOf([start(1), end(1, 'aborted'), start(2)]), undefined, 'an open later turn yields no terminal reason')
  // a later completed turn wins over an earlier one
  assert.equal(terminalReasonOf([start(1), end(1, 'aborted'), start(2), end(2, 'max-tokens')]), 'max-tokens')
})

test('finalOutputOf returns the last non-empty assistant text, truncated', () => {
  const assistant = (text) => ({
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: text ? [{ type: 'text', text }] : [] } },
  })
  const log = [assistant('first'), assistant(''), assistant('last answer')]
  assert.equal(finalOutputOf(log, 2000), 'last answer')
  assert.equal(finalOutputOf([assistant(''), assistant(null)], 2000), '')
  assert.equal(finalOutputOf([], 2000), '')
  // truncation applies
  const long = finalOutputOf([assistant('x'.repeat(500))], 100)
  assert.equal(long.length, 100)
})

test('settlementSummaryOf builds a one-line summary with optional closing text', () => {
  const s = settlementSummaryOf('child-1', 'completed', 'done!')
  assert.ok(s.includes('child-1') && s.includes('completed') && s.includes('done!'))
  const bare = settlementSummaryOf('child-1', 'error')
  assert.ok(bare.includes('child-1') && bare.includes('error'))
  assert.ok(!bare.includes('Closing'))
})

test('trimSettled evicts the oldest entries beyond the capacity', () => {
  const entries = [
    ['a', { at: 1 }],
    ['b', { at: 2 }],
    ['c', { at: 3 }],
  ]
  assert.deepEqual(trimSettled(entries, 10), entries)
  const trimmed = trimSettled(entries, 2)
  assert.equal(trimmed.length, 2)
  assert.equal(trimmed[0][0], 'b', 'oldest entry is evicted')
  assert.equal(trimmed[1][0], 'c')
  // empty / under-capacity pass through
  assert.deepEqual(trimSettled([], 5), [])
})

test('registerWaiter/resolveWaiters fan out and clean up without dynamic listeners', () => {
  const waiters = new Map()
  const calls = []
  const un1 = registerWaiter(waiters, 'c1', () => calls.push('a'))
  registerWaiter(waiters, 'c1', () => calls.push('b'))
  registerWaiter(waiters, 'c2', () => calls.push('x'))

  resolveWaiters(waiters, 'c1')
  assert.deepEqual(calls.sort(), ['a', 'b'])
  assert.ok(!waiters.has('c1'), 'resolved id is removed from the table')
  assert.ok(waiters.has('c2'), 'unrelated ids stay registered')

  // unregister removes exactly one waiter and prunes the id when empty
  const un2 = registerWaiter(waiters, 'c2', () => calls.push('y'))
  un2()
  un2() // idempotent
  assert.ok(waiters.has('c2'))
  un1() // stale unregister of an already-resolved id is a no-op
  resolveWaiters(waiters, 'c2')
  assert.deepEqual(calls.sort(), ['a', 'b', 'x'])
  assert.ok(!waiters.has('c2'))

  // resolving an id with no waiters is a no-op
  resolveWaiters(waiters, 'ghost')
  assert.equal(waiters.size, 0)
})

test('buildChildrenConfig filters subagents of one parent and merges settings/preset', () => {
  const overrides = new Map([
    ['child-1', { model: 'm1', reasoningEffort: 'high', agentPreset: 'code' }],
    ['child-2', { temperature: 0.4 }],
  ])
  const agents = [
    { id: 'child-1', status: 'running', session: { header: { origin: 'subagent', parentSession: 'parent-1' } } },
    { id: 'child-2', status: 'idle', session: { header: { origin: 'subagent', parentSession: 'parent-1' } } },
    { id: 'other', status: 'running', session: { header: { origin: 'subagent', parentSession: 'parent-9' } } },
    { id: 'root', status: 'running', session: { header: { origin: undefined, parentSession: undefined } } },
  ]
  const composed = new Map([['child-1', 'minimal']]) // live truth beats the override entry
  const rows = buildChildrenConfig('parent-1', agents, overrides, (agent) => composed.get(String(agent.id)))

  assert.equal(rows.length, 2)
  const c1 = rows.find((r) => r.id === 'child-1')
  assert.equal(c1.activity, 'running')
  assert.deepEqual(c1.settings, { model: 'm1', reasoningEffort: 'high', agentPreset: 'code' })
  assert.equal(c1.preset, 'minimal', 'composedPreset truth wins over the override entry')
  const c2 = rows.find((r) => r.id === 'child-2')
  assert.equal(c2.activity, 'inactive')
  assert.deepEqual(c2.settings, { temperature: 0.4 })
  assert.equal(c2.preset, undefined, 'no composed preset and no override preset -> undefined')

  // without a composedPresetOf provider the override entry backs the preset
  const rows2 = buildChildrenConfig('parent-1', agents, overrides, undefined)
  assert.equal(rows2.find((r) => r.id === 'child-1').preset, 'code')

  // empty inputs
  assert.deepEqual(buildChildrenConfig('p', [], new Map(), undefined), [])
  assert.equal(buildChildrenConfig('parent-1', agents, new Map(), undefined).length, 2)
})

test('mergeColdChildren appends durable catalog children missing from live rows', () => {
  const live = [{ id: 'c1', activity: 'running', settings: { model: 'm' }, preset: 'code' }]
  const catalog = [
    { kind: 'child', id: 'c1', activity: 'running', mode: 'continuable' },
    { kind: 'child', id: 'c2', activity: 'inactive', mode: 'continuable' },
    { kind: 'child', id: 'c3', activity: 'inactive', mode: 'one-shot' },
    { kind: 'diagnostic', id: 'd1', reason: 'corrupt' },
  ]
  const overrides = new Map([
    ['c2', { reasoningEffort: 'high', agentPreset: 'minimal' }],
    ['c3', { temperature: 0.2 }],
  ])
  const rows = mergeColdChildren(live, catalog, overrides)

  assert.equal(rows.length, 3, 'live row kept, cold children appended, diagnostics skipped')
  const c2 = rows.find((r) => r.id === 'c2')
  assert.equal(c2.activity, 'inactive')
  assert.deepEqual(c2.settings, { reasoningEffort: 'high', agentPreset: 'minimal' })
  assert.equal(c2.preset, 'minimal', 'override preset backs a cold child')
  const c3 = rows.find((r) => r.id === 'c3')
  assert.equal(c3.preset, undefined, 'no preset configured -> undefined')
  // empty catalog / no overrides
  assert.deepEqual(mergeColdChildren(live, [], new Map()), live)
})

test('resolveSendMode defaults to steer but falls back to followup for cold children', () => {
  // no mode + resident -> steer (the new default)
  assert.deepEqual(resolveSendMode(undefined, true), { mode: 'steer', fallback: false })
  // no mode + cold -> followup with a fallback note (keeps cold-resume usable)
  const coldDefault = resolveSendMode(undefined, false)
  assert.equal(coldDefault.mode, 'followup')
  assert.equal(coldDefault.fallback, true)
  // explicit followup always stays followup (cold or resident)
  assert.deepEqual(resolveSendMode('followup', false), { mode: 'followup', fallback: false })
  assert.deepEqual(resolveSendMode('followup', true), { mode: 'followup', fallback: false })
  // EXPLICIT steer/inject to a cold child now also falls back to followup
  // (a cold child cannot steer; deliver as followup instead of erroring).
  const coldSteer = resolveSendMode('steer', false)
  assert.equal(coldSteer.mode, 'followup')
  assert.equal(coldSteer.fallback, true)
  const coldInject = resolveSendMode('inject', false)
  assert.equal(coldInject.mode, 'followup')
  assert.equal(coldInject.fallback, true)
  // explicit steer/inject to a resident child stays as requested
  assert.deepEqual(resolveSendMode('steer', true), { mode: 'steer', fallback: false })
  assert.deepEqual(resolveSendMode('inject', true), { mode: 'inject', fallback: false })
})

test('inheritRouteFromHeader snapshots the parent session actual model for children', () => {
  const header = { provider: 'modlens-opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 384000 }
  // no explicit args -> full snapshot
  assert.deepEqual(inheritRouteFromHeader(header, {}), { provider: 'modlens-opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
  // explicit args win over the snapshot
  assert.deepEqual(inheritRouteFromHeader(header, { model: 'm2' }), { provider: 'modlens-opencode-go', model: 'm2', reasoningEffort: 'high' })
  assert.deepEqual(inheritRouteFromHeader(header, { provider: 'p2', reasoningEffort: 'max' }), { provider: 'p2', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
  // no header -> nothing inherited (current behavior)
  assert.deepEqual(inheritRouteFromHeader(undefined, {}), {})
  assert.deepEqual(inheritRouteFromHeader(undefined, { model: 'm' }), { model: 'm' })
  // reasoningEffort only inherited when the header carries it
  assert.deepEqual(inheritRouteFromHeader({ provider: 'p', model: 'm' }, {}), { provider: 'p', model: 'm' })
})

test('resolveEffectiveDisplay shows the actual model/reasoning values for the panel', () => {
  // explicit override wins
  assert.deepEqual(
    resolveEffectiveDisplay({ model: 'm1', reasoningEffort: 'high' }, { model: 'm0', reasoningEffort: 'low' }),
    { model: 'm1', reasoningEffort: 'high' },
  )
  // override missing -> effective (child header / parent header) value shown
  assert.deepEqual(
    resolveEffectiveDisplay({}, { model: 'm0', reasoningEffort: 'low' }),
    { model: 'm0', reasoningEffort: 'low' },
  )
  // per-field fallback
  assert.deepEqual(
    resolveEffectiveDisplay({ model: 'm1' }, { model: 'm0', reasoningEffort: 'low' }),
    { model: 'm1', reasoningEffort: 'low' },
  )
  // nothing known anywhere -> undefined (panel falls back to 继承)
  assert.deepEqual(resolveEffectiveDisplay({}, {}), { model: undefined, reasoningEffort: undefined })
})

test('resolveColdPreset prefers override > header snapshot > parent preset', () => {
  assert.equal(resolveColdPreset('code', 'cordis', 'standard'), 'code', 'explicit override wins')
  assert.equal(resolveColdPreset(undefined, 'cordis', 'standard'), 'cordis', 'header snapshot is the cold truth')
  assert.equal(resolveColdPreset('', 'cordis', 'standard'), 'cordis', 'empty override is ignored')
  assert.equal(resolveColdPreset(undefined, undefined, 'standard'), 'standard', 'parent preset is the last resort')
  assert.equal(resolveColdPreset(undefined, undefined, undefined), undefined)
})

test('mergeColdChildren uses header/parent presets for cold children', () => {
  const overrides = new Map([['c2', { reasoningEffort: 'high' }]])
  const catalog = [
    { kind: 'child', id: 'c2', activity: 'inactive', mode: 'continuable' },
    { kind: 'child', id: 'c3', activity: 'inactive', mode: 'continuable' },
  ]
  const headerPresetOf = (id) => (id === 'c2' ? 'cordis' : id === 'c3' ? 'minimal' : undefined)
  const rows = mergeColdChildren([], catalog, overrides, headerPresetOf, 'standard')

  const c2 = rows.find((r) => r.id === 'c2')
  assert.equal(c2.preset, 'cordis', 'header snapshot backs a cold child without an override preset')
  const c3 = rows.find((r) => r.id === 'c3')
  assert.equal(c3.preset, 'minimal', 'header snapshot shown for a never-overridden cold child')
  // parent preset fallback when no header preset is available
  const rows2 = mergeColdChildren([], catalog, overrides, () => undefined, 'standard')
  assert.equal(rows2.find((r) => r.id === 'c3').preset, 'standard')
  // legacy call shape without the new parameters still works
  const rows3 = mergeColdChildren([], catalog, overrides)
  assert.equal(rows3.find((r) => r.id === 'c3').preset, undefined)
})
