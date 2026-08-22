/**
 * dsh-subagent-supervisor
 *
 * Host-plane supervision tools that give the main agent four capabilities the
 * shipped subagent tools lack:
 *
 *  1. subagent_run    - delegate with per-call provider / model / maxTokens /
 *                       reasoningEffort / temperature (continuable children).
 *  2. subagent_send   - deliver to a continuable child as followup (FIFO next
 *                       turn), inject (next-step context, no wake), or steer
 *                       (next-step, wake: consumed at the child's next step
 *                       boundary inside its CURRENT turn), optionally after
 *                       cancelling the child's current activity.
 *  3. subagent_queue  - list / remove / clear the child's pending inbox
 *                       messages (next-turn + next-step), durable via the
 *                       child's own agent/inbox/spliced event stream.
 *  4. subagent_probe  - inspect the child's live status and its recent
 *                       step-by-step transcript (model config, user messages,
 *                       assistant text + reasoning, tool calls/results,
 *                       turn/step boundaries, errors), for resident AND cold
 *                       children.
 *  5. subagent_config - update a child's model/reasoning overrides mid-run;
 *                       applied at its next model request.
 *
 * Mechanisms used (all public APIs, zero core changes):
 *  - ctx.subagents.startContinuable() accepts per-call AgentOptions
 *    (provider/model/maxTokens) natively.
 *  - ctx.subagents.registerContinuableSetup() installs a child-scoped
 *    `agent/request` waterfall listener on every continuable child (fresh
 *    creation and cold resume) that applies reasoningEffort/temperature and
 *    any model/provider/maxTokens overrides per request. Scope-filtered
 *    dispatch guarantees the listener only ever sees that child's requests.
 *  - The Agent API exposes steer()/inject()/followup() and the Inbox exposes
 *    nextTurn/nextStep/remove/clear; delivery sources reuse the coordinator
 *    relay shape the shipped send_message tool uses.
 *  - sessionQuery.readSession() / traceSession() serve cold children and
 *    lineage authorization.
 *
 * The plugin row must live on the HOST plane (like @deepseek-ai/
 * dsh-tool-subagent-report): registerContinuableSetup is a process singleton
 * and mounting it once per preset would install every child twice.
 *
 * @module dsh-subagent-supervisor
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm/message'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'dsh-subagent-supervisor'
// webServer must be DECLARED via inject: at plugin-apply time ctx.get cannot
// resolve services (clientModules declares it the same way; dsh-restart's
// ctx.get-based endpoint is likewise 404 in this runtime).
export const inject = ['tools', 'subagents', 'agents', 'webServer']

/** Plugin configuration (optional row config in cordis.patch.yml). */
const Config = z.object({
  /** A running child with no new session event for this many minutes is flagged as stalled. */
  stallMinutes: z.number().min(0.1).default(15),
  /** Whether the stall detector injects reminders into the live parent. */
  stallReminder: z.boolean().default(true),
})

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Text of the text blocks in a content block array, concatenated. */
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** Total char length of text blocks (used for reasoning size summaries). */
function textLengthOf(blocks) {
  return textOfBlocks(blocks).length
}

/** Truncate a string with head/tail retention so oversized content stays bounded. */
function clip(text, maxChars) {
  if (typeof text !== 'string') return String(text ?? '')
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head - 3
  return text.slice(0, head) + '...' + text.slice(-tail)
}

/** The exact calling agent, or a loud failure for agentless callers. */
function requireCaller(exec) {
  const agent = exec && exec.agent
  if (!agent) throw new Error('subagent-supervisor tools require a calling agent (exec.agent was undefined)')
  return agent
}

/** Resolve the durable sessionQuery service, or fail with a deployment-level error. */
function requireSessionQuery(ctx) {
  const query = ctx.get('sessionQuery')
  if (!query) throw new Error('sessionQuery is unavailable in this deployment; this operation cannot verify lineage or read cold sessions')
  return query
}

/**
 * Authorize `caller` against the durable lineage of `childId`: the caller
 * must appear in the target's ancestor chain (same rule the continuation
 * manager applies to interrupt). Throws UNAUTHORIZED-style errors otherwise.
 */
async function assertAncestor(ctx, caller, childId, signal) {
  const target = String(childId)
  if (String(caller.id) === target) {
    throw new Error(`UNAUTHORIZED: cannot supervise your own session ${target}`)
  }
  const query = requireSessionQuery(ctx)
  let trace
  try {
    trace = await query.traceSession(target, signal)
  } catch (error) {
    throw new Error(`cannot verify lineage for subagent ${target}: ${String(error && error.message ? error.message : error)}`)
  }
  const ancestors = (trace && Array.isArray(trace.ancestors) ? trace.ancestors : []).map((r) => String(r.header.id))
  if (!ancestors.includes(String(caller.id))) {
    throw new Error(`UNAUTHORIZED: session ${target} is not a descendant of agent ${String(caller.id)}`)
  }
}

/**
 * Read the child's session events: live session when resident (authoritative
 * in-memory log), persisted snapshot otherwise.
 */
async function readChildSession(ctx, childId, signal) {
  const live = ctx.agents.get(childId)
  if (live) {
    return { header: live.session.header, events: live.session.events, live: true, status: live.status }
  }
  const query = requireSessionQuery(ctx)
  let snapshot
  try {
    snapshot = await query.readSession(childId, signal)
  } catch (error) {
    throw new Error(`cannot read subagent ${String(childId)}: ${String(error && error.message ? error.message : error)}`)
  }
  return { header: snapshot.session, events: snapshot.events, live: false, status: 'ready' }
}

/** Fold agent/inbox/spliced events into the current pending message lists. */
function foldPendingInbox(events) {
  const state = { 'next-turn': [], 'next-step': [] }
  for (const ev of events) {
    if (!ev || ev.type !== 'agent/inbox/spliced') continue
    const s = ev.data
    const list = state[s.target] ?? []
    list.splice(s.start, s.removedCount ?? 0, ...(Array.isArray(s.inserted) ? s.inserted : []))
  }
  return state
}

/** Event types that never appear in a probe transcript (streaming and log-only bookkeeping). */
const PROBE_NOISE_TYPES = new Set([
  'assistant/chunk',
  'request/header',
  'request/context',
  'todo/write',
  'session/end-seed',
  'agent/inbox/spliced',
])

/** The turn number carried by an event, when it has one. */
function turnOfEvent(ev) {
  const d = ev && ev.data
  if (!d || typeof d !== 'object') return undefined
  return typeof d.turn === 'number' ? d.turn : undefined
}

/**
 * Select the probe transcript window: drop streaming/log-only noise FIRST, then
 * honor `sinceTurn`, then keep the last `limit` meaningful events in log order.
 * Without the noise pre-filter a heavy stream (thousands of assistant/chunk
 * rows) would crowd the window entirely and render an empty transcript.
 */
function selectEventWindow(events, { limit, sinceTurn }) {
  const meaningful = []
  // Once sinceTurn is set, turn-less events (user/message) are kept only after
  // the log has passed the first turn at/after the boundary.
  let pastBoundary = false
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (PROBE_NOISE_TYPES.has(ev.type)) continue
    if (sinceTurn !== undefined) {
      const turn = turnOfEvent(ev)
      if (turn !== undefined) {
        if (turn < sinceTurn) continue
        pastBoundary = true
      } else if (!pastBoundary) {
        continue
      }
    }
    meaningful.push(ev)
  }
  if (limit !== undefined && Number.isInteger(limit) && limit > 0 && meaningful.length > limit) {
    return meaningful.slice(meaningful.length - limit)
  }
  return meaningful
}

/** Render one pending UserMessage as a compact queue row. */
function queueRowOf(message, index, list, previewChars) {
  return {
    list,
    index,
    messageId: String(message.id),
    text: clip(textOfBlocks(message.content), previewChars),
  }
}

/** Merge non-empty override fields from a tool call into the registry entry. */
function mergeOverrides(existing, args) {
  const next = { ...(existing || {}) }
  if (args.provider !== undefined && args.provider !== '') next.provider = args.provider
  if (args.model !== undefined && args.model !== '') next.model = args.model
  if (args.maxTokens !== undefined && Number.isInteger(args.maxTokens) && args.maxTokens > 0) next.maxTokens = args.maxTokens
  if (args.reasoningEffort !== undefined && args.reasoningEffort !== '') next.reasoningEffort = args.reasoningEffort
  if (args.temperature !== undefined && typeof args.temperature === 'number' && Number.isFinite(args.temperature)) {
    next.temperature = args.temperature
  }
  if (args.agent_preset !== undefined && args.agent_preset !== '') next.agentPreset = args.agent_preset
  return next
}

/** Build the coordinator relay source the shipped send_message tool uses. */
function coordinatorSource(parent) {
  return { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }
}

/**
 * Copy an object dropping keys whose value is `undefined`. Tool results must
 * be lossless JSON for the registry's output validator, which rejects
 * undefined values even where JSON.stringify would drop them.
 */
function definedOnly(obj) {
  const out = {}
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined) out[key] = obj[key]
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Phase A: reasoningEffort pre-validation
 * ------------------------------------------------------------------ */

/**
 * Check one requested reasoning effort against an adapter's resolved model
 * info (`llm.resolveModelInfo`). Opaque adapter ids compare exactly; when the
 * adapter exposes no efforts the check passes through (the child failure
 * would surface through probe instead).
 * @param effort - requested reasoning effort id, or undefined.
 * @param info - LlmResolvedModelInfo (or anything shaped like it).
 * @returns `{ok: true}` (possibly `skipped: true`), or `{ok: false, supported}`.
 */
function validateEffortAgainstModelInfo(effort, info) {
  if (effort === undefined || effort === null || effort === '') return { ok: true, skipped: true }
  const reasoning = info && info.reasoning
  const efforts = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : undefined
  if (!efforts || efforts.length === 0) return { ok: true, skipped: true }
  const supported = efforts
    .map((e) => (e && typeof e === 'object' && typeof e.id === 'string' ? e.id : undefined))
    .filter((id) => id !== undefined)
  if (supported.includes(effort)) return { ok: true }
  return { ok: false, supported }
}

/**
 * Resolve the effective provider/model route for a delegation, mirroring the
 * child's own inheritance order: explicit args > existing overrides > the
 * parent's route. Validation must test the route the child would actually use.
 */
function resolveEffectiveRoute(args, parentOptions, overrides) {
  const a = args || {}
  const p = parentOptions || {}
  const o = overrides || {}
  return {
    provider: a.provider && a.provider !== ''
      ? a.provider
      : o.provider && o.provider !== ''
        ? o.provider
        : p.provider !== undefined
          ? p.provider
          : undefined,
    model: a.model && a.model !== ''
      ? a.model
      : o.model && o.model !== ''
        ? o.model
        : p.model !== undefined
          ? p.model
          : undefined,
  }
}

/**
 * Fail-fast validation of a requested reasoning effort against the adapter's
 * resolved model info. Passes through (no-op) when the effort is absent, the
 * route cannot be resolved, the llm service is unavailable, or the adapter
 * does not expose effort metadata — those cases keep the current behavior.
 * @throws when the adapter explicitly does not support the requested effort.
 */
async function checkReasoningEffort(ctx, route, effort, signal) {
  if (effort === undefined || effort === null || effort === '') return
  if (!route.provider || !route.model) return
  const llm = ctx.get('llm')
  if (!llm || typeof llm.resolveModelInfo !== 'function') return
  let info
  try {
    info = await llm.resolveModelInfo(route.provider, route.model, signal)
  } catch {
    return
  }
  const verdict = validateEffortAgainstModelInfo(effort, info)
  if (verdict.ok) return
  const supported = verdict.supported && verdict.supported.length > 0 ? `; supported: [${verdict.supported.join(', ')}]` : ''
  throw new Error(`provider "${route.provider}" model "${route.model}" does not support reasoning effort "${effort}"${supported}`)
}

/* ------------------------------------------------------------------ *
 * Phase B: override registry persistence
 * ------------------------------------------------------------------ */

/**
 * Resolve the harness home: `$DSH_HOME` (tilde-expanded) when set, else
 * `~/.dsh`. Same convention as dsh-tool-search.
 */
function resolveDshHome(dshHome) {
  const expand = (value) => (value.startsWith('~') ? `${homedir()}${value.slice(1)}` : value)
  if (dshHome !== undefined && dshHome !== '') return expand(String(dshHome))
  const env = typeof process !== 'undefined' ? process.env.DSH_HOME : undefined
  if (env !== undefined && env !== '') return expand(String(env))
  return join(homedir(), '.dsh')
}

/** Absolute path of the plugin's override registry file. */
function resolveOverridesFilePath(dshHome) {
  return join(resolveDshHome(dshHome), 'subagent-supervisor', 'overrides.json')
}

/**
 * Parse the persisted override registry file into a plain childId -> entry
 * map. Tolerates missing/corrupt input (returns null); drops malformed
 * entries; keeps only known, type-valid fields.
 */
function parseOverridesFile(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  if (obj.version !== 1) return null
  const entries = obj.entries
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null
  const out = {}
  for (const key of Object.keys(entries)) {
    const entry = entries[key]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const clean = {}
    if (typeof entry.provider === 'string' && entry.provider !== '') clean.provider = entry.provider
    if (typeof entry.model === 'string' && entry.model !== '') clean.model = entry.model
    if (Number.isInteger(entry.maxTokens) && entry.maxTokens > 0) clean.maxTokens = entry.maxTokens
    if (typeof entry.reasoningEffort === 'string' && entry.reasoningEffort !== '') clean.reasoningEffort = entry.reasoningEffort
    if (typeof entry.temperature === 'number' && Number.isFinite(entry.temperature)) clean.temperature = entry.temperature
    if (typeof entry.agentPreset === 'string' && entry.agentPreset !== '') clean.agentPreset = entry.agentPreset
    if (typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)) clean.updatedAt = entry.updatedAt
    if (Object.keys(clean).length > 0) out[key] = clean
  }
  return out
}

/** Serialize the registry map to the versioned file shape, stamping updatedAt. */
function serializeOverridesFile(entries) {
  const clean = {}
  for (const key of Object.keys(entries || {})) {
    const entry = entries[key]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    clean[key] = { ...entry, updatedAt: Date.now() }
  }
  return JSON.stringify({ version: 1, entries: clean }, null, 2)
}

/* ------------------------------------------------------------------ *
 * Settlement closure helpers
 * ------------------------------------------------------------------ */

/**
 * Classify a child's settlement state from its log tail and pending inbox
 * counts:
 *  - `unknown`: no turn boundary events at all (never started / empty log).
 *  - `active`: an open turn (the last turn boundary is a turn/start, or a new
 *    turn started after the last turn/end).
 *  - `queued`: a completed turn but pending inbox work remains (a later turn
 *    may still run).
 *  - `settled`: a completed turn with no pending work.
 */
function classifySettlement(events, pendingCounts) {
  let lastBoundary = undefined
  for (const ev of events) {
    if (ev && (ev.type === 'turn/start' || ev.type === 'turn/end')) lastBoundary = ev.type
  }
  if (lastBoundary === undefined) return 'unknown'
  if (lastBoundary === 'turn/start') return 'active'
  const pending = pendingCounts || {}
  if ((pending.nextTurn ?? 0) > 0 || (pending.nextStep ?? 0) > 0) return 'queued'
  return 'settled'
}

/**
 * The last non-empty assistant message text (same rule as the subagent
 * seam's finalAssistantOutput: empty-content messages are skipped).
 */
function finalOutputOf(events, maxChars) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || ev.type !== 'assistant/message') continue
    const content = ev.data && ev.data.message && ev.data.message.content
    const text = textOfBlocks(content)
    if (text.length === 0) continue
    return clip(text, maxChars)
  }
  return ''
}

/**
 * The reason kind of the LAST closed turn, or undefined when no turn has
 * ended (or a later turn is still open). Used to report the true terminal
 * state of a cold child classified as settled from its log.
 */
function terminalReasonOf(events) {
  let reason = undefined
  for (const ev of events) {
    if (!ev) continue
    if (ev.type === 'turn/end') {
      const kind = ev.data && ev.data.reason && ev.data.reason.kind
      if (typeof kind === 'string') reason = kind
    } else if (ev.type === 'turn/start') {
      reason = undefined
    }
  }
  return reason
}

/** One-line settlement summary for wait/probe surfaces. */
function settlementSummaryOf(childId, stopReason, closingText) {
  const line = `subagent "${childId}" ended: ${stopReason}`
  return closingText === undefined || closingText === ''
    ? line
    : `${line}\nClosing message:\n${clip(closingText, 2000)}`
}

/** FIFO capacity trim for the in-process settlement registry. */
function trimSettled(entries, max) {
  if (entries.length <= max) return entries
  return entries.slice(entries.length - max)
}

/**
 * Register one settlement waiter for a child id. The waiter table lives in the
 * plugin's apply scope and is resolved by the same `subagent/end` listener that
 * feeds the settled registry — no dynamic listener registration during tool
 * execution (cordis exposes `ctx.on` with a disposer, not `ctx.off`).
 * @returns idempotent unregister that prunes the id when the set empties.
 */
function registerWaiter(waiters, childId, resolve) {
  let set = waiters.get(childId)
  if (set === undefined) {
    set = new Set()
    waiters.set(childId, set)
  }
  set.add(resolve)
  let removed = false
  return () => {
    if (removed) return
    removed = true
    const current = waiters.get(childId)
    if (current !== undefined) {
      current.delete(resolve)
      if (current.size === 0) waiters.delete(childId)
    }
  }
}

/** Resolve every waiter of one child id and drop the id from the table. */
function resolveWaiters(waiters, childId) {
  const set = waiters.get(childId)
  if (set === undefined) return
  waiters.delete(childId)
  for (const resolve of [...set]) {
    try { resolve() } catch { /* containment: one waiter must not break the fan-out */ }
  }
}

/**
 * Build the browser-facing "children config" payload for one parent session:
 * every live subagent child of that parent, each with its override-registry
 * settings (the model / reasoning / preset the parent SET for it) and the
 * effective preset (live composedPreset truth when available, else the
 * override entry). Pure: `composedPresetOf` abstracts the agentPresets call.
 */
function buildChildrenConfig(parentId, agents, overrides, composedPresetOf) {
  const rows = []
  for (const agent of agents) {
    const header = agent && agent.session && agent.session.header
    if (!header || header.origin !== 'subagent') continue
    if (String(header.parentSession) !== String(parentId)) continue
    const id = String(agent.id)
    const entry = overrides.get(id)
    const preset = composedPresetOf !== undefined ? composedPresetOf(agent) : undefined
    rows.push({
      id,
      activity: agent.status === 'running' ? 'running' : 'inactive',
      settings: entry !== undefined ? { ...entry } : {},
      ...(preset !== undefined
        ? { preset }
        : entry !== undefined && entry.agentPreset !== undefined
          ? { preset: entry.agentPreset }
          : {}),
    })
  }
  return rows
}

/**
 * Append durable-catalog children (cold/ready, from subagents.listChildren)
 * to the live rows produced by buildChildrenConfig. Diagnostics are skipped
 * and live ids are not duplicated. A cold child's settings come from the
 * override registry; its preset comes from `resolveColdPreset` (override >
 * header snapshot > parent preset), so a cold child keeps showing the preset
 * it actually runs on instead of a bare "inherited" label.
 */
function mergeColdChildren(liveRows, catalogEntries, overrides, headerPresetOf, parentPreset) {
  const liveIds = new Set(liveRows.map((row) => row.id))
  const rows = [...liveRows]
  for (const entry of catalogEntries) {
    if (entry.kind !== 'child') continue
    const id = String(entry.id)
    if (liveIds.has(id)) continue
    const ov = overrides.get(id)
    const preset = resolveColdPreset(
      ov !== undefined ? ov.agentPreset : undefined,
      headerPresetOf !== undefined ? headerPresetOf(id) : undefined,
      parentPreset,
    )
    rows.push({
      id,
      activity: entry.activity === 'running' ? 'running' : 'inactive',
      settings: ov !== undefined ? { ...ov } : {},
      ...(preset !== undefined ? { preset } : {}),
    })
    liveIds.add(id)
  }
  return rows
}

/**
 * Resolve the ACTUAL delivery mode for subagent_send. The default is now
 * `steer` (interrupt-style, consumed inside the running child's current turn)
 * — except that a COLD child cannot steer, so an unspecified mode falls back
 * to `followup` (cold resume) to keep the common path usable. An EXPLICIT
 * steer/inject against a cold child is NOT downgraded (the caller asked for
 * it; the execute layer reports the resident-required error).
 * @returns `{mode, fallback}` — fallback=true only for the implicit
 *   default-steer-to-cold case.
 */
function resolveSendMode(requestedMode, isResident) {
  const mode = requestedMode === undefined || requestedMode === null || requestedMode === '' ? 'steer' : requestedMode
  if (mode === 'steer' || mode === 'inject') {
    if (!isResident) {
      // A cold child cannot steer/inject; deliver as followup instead of
      // erroring — explicit modes included (the caller gets the actual mode
      // in the response and a fallback note).
      return { mode: 'followup', fallback: true }
    }
  }
  return { mode, fallback: false }
}

/**
 * Snapshot the route a NEW child would actually inherit from its parent: the
 * parent session's LAST actual request header (what the UI shows as the
 * session's model). This blocks the "other session picked a model and the
 * global default polluted this session's children" surprise — the child
 * inherits THIS session's actual model, not the process-global default.
 * Explicit args win; fields the header lacks are not inherited.
 */
function inheritRouteFromHeader(headerConfig, args) {
  const out = {}
  const cfg = headerConfig || {}
  if (args.provider !== undefined && args.provider !== '') out.provider = args.provider
  else if (cfg.provider !== undefined && cfg.provider !== '') out.provider = cfg.provider
  if (args.model !== undefined && args.model !== '') out.model = args.model
  else if (cfg.model !== undefined && cfg.model !== '') out.model = cfg.model
  if (args.reasoningEffort !== undefined && args.reasoningEffort !== '') out.reasoningEffort = args.reasoningEffort
  else if (cfg.reasoningEffort !== undefined && cfg.reasoningEffort !== '') out.reasoningEffort = cfg.reasoningEffort
  return out
}

/**
 * The actual model/reasoning a child runs on, for the panel's labels:
 * explicit override first, then the effective (child's own request header for
 * live children, or the parent's header as the inherited source for cold
 * children). Undefined means nothing is known anywhere — the panel shows 继承.
 */
function resolveEffectiveDisplay(overrideSettings, effectiveConfig) {
  const ov = overrideSettings || {}
  const eff = effectiveConfig || {}
  return {
    model: ov.model !== undefined && ov.model !== '' ? ov.model : eff.model !== undefined && eff.model !== '' ? eff.model : undefined,
    reasoningEffort: ov.reasoningEffort !== undefined && ov.reasoningEffort !== ''
      ? ov.reasoningEffort
      : eff.reasoningEffort !== undefined && eff.reasoningEffort !== ''
        ? eff.reasoningEffort
        : undefined,
  }
}

/**
 * The preset a COLD child actually runs on (what a cold resume would restore):
 * the explicit override the parent set wins; otherwise the session header
 * snapshot (the parent's preset at creation time); otherwise the parent's
 * current preset as a last resort. Undefined only when nothing is known.
 */
function resolveColdPreset(overridePreset, headerPreset, parentPreset) {
  if (overridePreset !== undefined && overridePreset !== '') return overridePreset
  if (headerPreset !== undefined && headerPreset !== '') return headerPreset
  if (parentPreset !== undefined && parentPreset !== '') return parentPreset
  return undefined
}

/* ------------------------------------------------------------------ *
 * apply
 * ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const { stallMinutes, stallReminder } = Config(config)
  /** childId -> { provider?, model?, maxTokens?, reasoningEffort?, temperature? } */
  const overrides = new Map()
  const tools = []

  /* ---- settlement registry (in-process, FIFO-bounded) ----------------- */
  // Records every subagent settlement observed in this process so probe and
  // wait can answer "is it done?" even when the parent's notice was lost
  // (parent not live, parent turn aborted with pending steering cleared, or a
  // delivery exception). The child's own log remains the durable source.
  // `waiters` is the sibling table used by subagent_wait's live path: both are
  // fed by this ONE listener, so tools never register dynamic listeners.
  const SETTLED_MAX = 200
  const settled = new Map()
  const waiters = new Map()
  ctx.on('subagent/end', ({ id, stopReason, lastAssistantMessage }) => {
    const key = String(id)
    if (settled.size >= SETTLED_MAX) settled.delete(settled.keys().next().value)
    settled.set(key, {
      stopReason,
      at: Date.now(),
      ...(Array.isArray(lastAssistantMessage) ? { closingText: clip(textOfBlocks(lastAssistantMessage), 2000) } : {}),
    })
    resolveWaiters(waiters, key)
  })

  /* ---- persisted override registry ---------------------------------- */
  // The registry survives process restarts: loaded at apply from
  // `$DSH_HOME/subagent-supervisor/overrides.json`, replayed on every later
  // change (fire-and-forget, atomic tmp+rename, best-effort).
  const overridesFile = resolveOverridesFilePath(typeof process !== 'undefined' ? process.env.DSH_HOME : undefined)
  try {
    const text = readFileSync(overridesFile, 'utf8')
    const parsed = parseOverridesFile(text)
    if (parsed !== null) {
      for (const [childId, entry] of Object.entries(parsed)) overrides.set(childId, entry)
    } else {
      ctx.logger.warn(`dsh-subagent-supervisor: ignoring corrupt override registry at ${overridesFile}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') ctx.logger.warn(`dsh-subagent-supervisor: cannot read override registry: ${String(error)}`)
  }
  let persistChain = Promise.resolve()
  function persistOverrides() {
    const snapshot = {}
    for (const [childId, entry] of overrides) snapshot[childId] = entry
    const text = serializeOverridesFile(snapshot)
    persistChain = persistChain
      .then(async () => {
        await mkdir(dirname(overridesFile), { recursive: true })
        const tmp = `${overridesFile}.tmp`
        await writeFile(tmp, text, 'utf8')
        await rename(tmp, overridesFile)
      })
      .catch((error) => {
        ctx.logger.warn(`dsh-subagent-supervisor: failed to persist override registry: ${String(error)}`)
      })
    return persistChain
  }

  /* ---- per-child model/reasoning override waterfall ------------------ */
  // Installed into every continuable child's unpublished scope at fresh
  // creation AND cold resume. Scope-filtered dispatch means these listeners
  // only ever see this child's own events.
  ctx.subagents.registerContinuableSetup((childCtx) => {
    const listener = (payload, next) =>
      next().then((config) => {
        const ov = overrides.get(String(payload.agent.id))
        if (!ov) return config
        const merged = { ...config }
        if (ov.provider) merged.provider = ov.provider
        if (ov.model) merged.model = ov.model
        if (ov.maxTokens !== undefined) merged.maxTokens = ov.maxTokens
        if (ov.reasoningEffort) merged.reasoningEffort = ov.reasoningEffort
        if (ov.temperature !== undefined) merged.temperature = ov.temperature
        return merged
      })
    const disposeRequest = childCtx.on('agent/request', listener)

    // Custom agent preset: re-link this child to the target preset's standing
    // composition BEFORE its first step assembles system/tools. The override
    // entry is written by the delegating tool only AFTER startContinuable
    // resolves, so the creation window itself cannot see it — the first
    // `agent/pre-step` (which runs before request assembly) is the earliest
    // guaranteed point where the entry exists. The per-installation Set
    // dedupes within one Activation; cold resume re-installs the contribution,
    // so a fresh Set restores the preset recorded for this child (a restore,
    // not a mid-conversation tool swap). The tool layer already validated the
    // preset id and pre-composed its standing mount; a failure here degrades
    // to the inherited preset with a warning rather than blocking the step.
    const relinked = new Set()
    const relinkIfNeeded = async (agentId) => {
      const key = String(agentId)
      const ov = overrides.get(key)
      if (!ov || !ov.agentPreset || relinked.has(key)) return
      const presets = childCtx.get('agentPresets')
      if (!presets || typeof presets.recompose !== 'function') return
      await presets.recompose(childCtx, ov.agentPreset)
      relinked.add(key)
    }
    const disposeRelink = childCtx.on('agent/pre-step', (payload, next) =>
      relinkIfNeeded(payload.agent.id).catch((error) => {
        ctx.logger.warn(`dsh-subagent-supervisor: preset re-link failed for ${String(payload.agent.id)}: ${String(error)}`)
      }).then(() => next()),
    )

    return () => {
      disposeRequest()
      disposeRelink()
    }
  })

  // NOTE: override entries intentionally live for the child's whole lifetime
  // and are persisted to $DSH_HOME/subagent-supervisor/overrides.json, so a
  // restart replays them for cold-resumed children. They are NOT dropped on
  // subagent/end: a child that settles with queued follow-up work later
  // starts new turns, and those turns must keep the configuration the parent
  // set for this child.

  /* ---- subagent_run ------------------------------------------------ */
  tools.push(ctx.tools.register(defineTool({
    name: 'subagent_run',
    description:
      'Delegate a self-contained task to a NEW background subagent with explicit model, reasoning, and preset settings. ' +
      'Unlike subagent, you can name the child\'s provider/model/maxTokens, its reasoning intensity (reasoningEffort, temperature), and its Agent preset (agent_preset) for this delegation alone; ' +
      'omitted fields inherit your own route and preset. The child runs in the background as a continuable subagent: this call returns a durable subagent id immediately, ' +
      'the runtime sends you a notice when the run settles, and you manage the child afterwards with subagent_send / subagent_queue / subagent_probe / subagent_config / interrupt_agent.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.',
      },
      provider: {
        type: 'string',
        description: 'Optional provider route for the child (must have a registered adapter at call time). Omit to inherit your own provider.',
      },
      model: {
        type: 'string',
        description: 'Optional model id for the child, interpreted by the selected provider. Omit to inherit your own model.',
      },
      maxTokens: {
        type: 'integer',
        description: 'Optional maximum output tokens per child model request.',
      },
      reasoningEffort: {
        type: 'string',
        description: 'Optional reasoning intensity for the child\'s requests (adapter-dependent effort id, e.g. low/medium/high). Applied from the child\'s first request onward.',
      },
      temperature: {
        type: 'number',
        description: 'Optional sampling temperature for the child\'s requests (typically 0-2). Applied from the child\'s first request onward.',
      },
      agent_preset: {
        type: 'string',
        description: 'Optional Agent preset the child is composed from (standard/code/minimal/cordis or a locally authored id, e.g. under ~/.dsh/.agent-presets). Omit to inherit your own preset. Validated and pre-composed before the child starts; an unknown or unusable preset fails the call.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'continuable' },
          subagentId: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          applied: {
            type: 'object',
            additionalProperties: true,
            properties: {},
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `started subagent ${value.subagentId}${Object.keys(value.applied).length > 0 ? ` with config ${JSON.stringify(value.applied)}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const parent = requireCaller(exec)
      const agentOptions = {}
      if (args.provider) agentOptions.provider = args.provider
      if (args.model) agentOptions.model = args.model
      if (args.maxTokens !== undefined) agentOptions.maxTokens = args.maxTokens
      const applied = mergeOverrides(undefined, args)
      // Inherit THIS session's ACTUAL route (its last request header), not the
      // process-global default — otherwise picking a model in another session
      // would silently change what this session's children inherit.
      const parentHeader = parent.session && typeof parent.session.requestHeader === 'function' ? parent.session.requestHeader() : undefined
      const inherited = inheritRouteFromHeader(parentHeader ? parentHeader.config : undefined, args)
      if (inherited.provider !== undefined && agentOptions.provider === undefined) agentOptions.provider = inherited.provider
      if (inherited.model !== undefined && agentOptions.model === undefined) agentOptions.model = inherited.model
      // Also surface the snapshot in `applied` so the returned config and the
      // override registry (cold-resume replay) record the child's real route.
      if (inherited.provider !== undefined && applied.provider === undefined) applied.provider = inherited.provider
      if (inherited.model !== undefined && applied.model === undefined) applied.model = inherited.model
      if (inherited.reasoningEffort !== undefined) {
        if (applied.reasoningEffort === undefined) applied.reasoningEffort = inherited.reasoningEffort
      }
      // Fail fast before spending a delegation on a route the adapter rejects.
      await checkReasoningEffort(ctx, resolveEffectiveRoute(args, parent.options, undefined), args.reasoningEffort ?? applied.reasoningEffort, exec.signal)
      // Fail fast on an unknown/unusable agent preset, and pre-compose its
      // standing mount so the creation-window re-link has no mount latency.
      if (applied.agentPreset !== undefined) {
        const presets = ctx.get('agentPresets')
        if (!presets) throw new Error('agentPresets is unavailable in this deployment; cannot compose a custom agent preset')
        await presets.resolve(applied.agentPreset)
        await presets.standingKeyFor(applied.agentPreset)
      }
      const request = {
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      }
      const start = await ctx.subagents.startContinuable({
        provider: 'spawn',
        label: args.description,
        request,
        signal: exec.signal,
      })
      const childId = String(start.childId)
      if (Object.keys(applied).length > 0) {
        overrides.set(childId, applied)
        persistOverrides()
      }
      return {
        kind: 'continuable',
        subagentId: childId,
        messageId: String(start.messageId),
        applied,
      }
    },
  })))

  /* ---- subagent_send ------------------------------------------------ */
  tools.push(ctx.tools.register(defineTool({
    name: 'subagent_send',
    description:
      'Deliver a message to one of your continuable subagents in three modes. ' +
      'steer (default) submits the message for the child\'s next step boundary: a running child consumes it INSIDE its current turn at the end of the current step, so it can redirect work that is between steps, but it cannot interrupt an in-flight model request or tool execution. ' +
      'When the child is not resident (cold), steer/inject automatically fall back to followup (cold resume) — never an error. ' +
      'followup queues the message as the child\'s next FIFO turn: if the child is still working it waits until the current turn finishes (works for resident and cold children). ' +
      'inject is like steer but does not wake the driver and is consumed as context at the next pre-step. ' +
      'Set cancel_first=true to first request cancellation of the child\'s current activity (like interrupt_agent, which preserves queued work); the steered/follow-up message then runs after the interrupted activity converges. ' +
      'This call returns only delivery confirmation, never the child\'s answer; a failure means the message was NOT delivered. inspect progress with subagent_probe.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The durable subagent id returned by subagent_run or subagent.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the subagent.',
      },
      mode: {
        type: 'string',
        enum: ['followup', 'inject', 'steer'],
        description: 'steer (default) interrupts at the next step boundary inside the current turn; inject adds context at the next pre-step without waking; followup queues a new turn (a cold child is auto-fell-back to followup when no mode is given).',
      },
      cancel_first: {
        type: 'boolean',
        description: 'When true, first request cancellation of the child\'s current activity (queued work is preserved). Only the current activity stops; the child stays available.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          cancelled: { type: 'boolean', required: true },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `delivered to subagent ${args.subagent_id} (${value.mode})${value.cancelled ? ' after cancel request' : ''} as message ${value.messageId}`,
      }],
    },
    async execute(args, exec) {
      const parent = requireCaller(exec)
      const childId = String(args.subagent_id)
      // Default is steer (interrupt-style) with an automatic fallback to
      // followup for cold children; an explicit mode is never downgraded.
      const child = ctx.agents.get(childId)
      const { mode, fallback } = resolveSendMode(args.mode, child !== undefined)
      const cancelFirst = args.cancel_first === true
      const blocks = [{ type: 'text', text: args.message }]
      const source = coordinatorSource(parent)

      if (mode === 'followup') {
        if (cancelFirst) ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
        const messageId = await ctx.subagents.followup(parent, childId, blocks, { source, signal: exec.signal })
        return {
          mode,
          messageId: String(messageId),
          cancelled: cancelFirst,
          note: fallback
            ? 'child is not resident; steer/inject cannot reach a cold child, so the message was delivered as followup (cold resume)'
            : cancelFirst
              ? 'queued as the next turn; the interrupted activity converges before it runs'
              : 'queued as the next FIFO turn; it runs when the current turn finishes',
        }
      }

      // steer / inject require the child to be resident: they mutate the live
      // inbox of an Agent object, which only exists while the child is loaded.
      if (!child) {
        throw new Error(`subagent ${childId} is not resident in this process; ${mode} requires a live agent — use mode followup (cold resume is supported) or wait until the child is active`)
      }
      await assertAncestor(ctx, parent, childId, exec.signal)
      if (cancelFirst) ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
      const message = freezeMessage(createUserMessage({ content: blocks, source }))
      if (mode === 'steer') child.steer(message)
      else child.inject(message)
      return {
        mode,
        messageId: String(message.id),
        cancelled: cancelFirst,
        note: mode === 'steer'
          ? 'submitted for the next step boundary inside the current turn; it cannot interrupt an in-flight model request or tool execution'
          : 'submitted as context for the next pre-step without waking the driver',
      }
    },
  })))

  /* ---- subagent_queue ---------------------------------------------- */
  tools.push(ctx.tools.register(defineTool({
    name: 'subagent_queue',
    description:
      'Manage one of your continuable subagents\' pending message queue. ' +
      'list returns the pending next-turn and next-step messages with their ids (resident children show live inbox state; cold children reconstruct it from their durable log). ' +
      'remove deletes one pending message by id (only works for resident children; a message already claimed into a turn can no longer be removed). ' +
      'clear empties ALL pending messages without touching the child\'s current activity (resident children only). All mutations are durable.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The durable subagent id.',
      },
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'remove', 'clear'],
        description: 'list (default view of pending work), remove one message, or clear all pending messages.',
      },
      message_id: {
        type: 'string',
        description: 'Required for action=remove: the pending message id from a list call.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subagent_id: { type: 'string', required: true },
          action: { type: 'string', required: true },
          resident: { type: 'boolean', required: true },
          next_turn: {
            type: 'array',
            items: { type: 'json' },
          },
          next_step: {
            type: 'array',
            items: { type: 'json' },
          },
          removed: { type: 'boolean' },
          cleared: { type: 'json' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => {
        if (value.action === 'remove') {
          return [{ type: 'text', text: `remove ${value.removed ? 'succeeded' : 'failed (message not pending)'} for subagent ${value.subagent_id}` }]
        }
        if (value.action === 'clear') {
          const c = value.cleared || {}
          return [{ type: 'text', text: `cleared ${c.nextTurn ?? 0} next-turn and ${c.nextStep ?? 0} next-step messages for subagent ${value.subagent_id}` }]
        }
        const lines = [`pending queue for subagent ${value.subagent_id} (resident=${value.resident}):`]
        for (const row of value.next_turn) lines.push(`  next-turn #${row.index} ${row.messageId}: ${row.text}`)
        for (const row of value.next_step) lines.push(`  next-step #${row.index} ${row.messageId}: ${row.text}`)
        if (value.next_turn.length + value.next_step.length === 0) lines.push('  (empty)')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const parent = requireCaller(exec)
      const childId = String(args.subagent_id)
      await assertAncestor(ctx, parent, childId, exec.signal)
      const action = args.action
      const child = ctx.agents.get(childId)
      const previewChars = 200

      if (action === 'list') {
        if (child) {
          return {
            subagent_id: childId,
            action,
            resident: true,
            next_turn: child.inbox.nextTurn.map((m, i) => queueRowOf(m, i, 'next-turn', previewChars)),
            next_step: child.inbox.nextStep.map((m, i) => queueRowOf(m, i, 'next-step', previewChars)),
          }
        }
        const { events } = await readChildSession(ctx, childId, exec.signal)
        const folded = foldPendingInbox(events)
        return {
          subagent_id: childId,
          action,
          resident: false,
          next_turn: folded['next-turn'].map((m, i) => queueRowOf(m, i, 'next-turn', previewChars)),
          next_step: folded['next-step'].map((m, i) => queueRowOf(m, i, 'next-step', previewChars)),
          note: 'reconstructed from the durable log; remove/clear require a resident child',
        }
      }

      if (!child) {
        throw new Error(`queue ${action} requires a resident subagent; ${childId} is not loaded in this process (read-only list is available)`)
      }
      if (action === 'remove') {
        if (!args.message_id) throw new Error('action=remove requires message_id')
        const removed = child.inbox.remove(args.message_id)
        return { subagent_id: childId, action, resident: true, removed, note: removed ? '' : 'the message was not pending (already claimed into a turn or already removed)' }
      }
      // clear
      const cleared = { nextTurn: child.inbox.nextTurn.length, nextStep: child.inbox.nextStep.length }
      child.inbox.clear()
      return {
        subagent_id: childId,
        action,
        resident: true,
        cleared,
        note: 'pending lists cleared; the child\'s current activity was not interrupted',
      }
    },
  })))

  /* ---- subagent_probe ---------------------------------------------- */
  tools.push(ctx.tools.register(defineTool({
    name: 'subagent_probe',
    description:
      'Inspect one of your continuable subagents: its live status, effective model configuration, pending queue, and a step-by-step window of its transcript ' +
      '(user messages, assistant text and reasoning, tool calls and results, turn/step boundaries, errors). ' +
      'Works for resident AND cold children (durable log). Use it to check what a long-running child is doing before deciding to steer or interrupt it. ' +
      'Reasoning text is hidden by default; pass include_reasoning=true to see it.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The durable subagent id.',
      },
      limit: {
        type: 'integer',
        description: 'How many most-recent events to scan (default 200, min 10, max 2000).',
      },
      since_turn: {
        type: 'integer',
        description: 'Only report events of this turn number or later (overrides limit).',
      },
      include_reasoning: {
        type: 'boolean',
        description: 'Show reasoning block text; default false (reasoning size is summarized instead).',
      },
      max_chars: {
        type: 'integer',
        description: 'Total output budget in characters (default 20000, min 2000, max 100000).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subagent_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          resident: { type: 'boolean', required: true },
          agent_preset: { type: 'string' },
          settlement: { type: 'json' },
          effective_config: { type: 'json' },
          transcript: { type: 'string', required: true },
          pending_summary: { type: 'json' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `subagent ${value.subagent_id} [${value.status}]${value.effective_config ? ` config=${JSON.stringify(value.effective_config)}` : ''}\n${value.transcript}`,
      }],
    },
    async execute(args, exec) {
      const parent = requireCaller(exec)
      const childId = String(args.subagent_id)
      await assertAncestor(ctx, parent, childId, exec.signal)
      const { header, events, live, status } = await readChildSession(ctx, childId, exec.signal)

      const limit = Math.max(10, Math.min(args.limit ?? 200, 2000))
      const sinceTurn = args.since_turn
      const includeReasoning = args.include_reasoning === true
      const totalBudget = Math.max(2000, Math.min(args.max_chars ?? 20000, 100000))
      const blockChars = Math.floor(totalBudget * 0.2)

      // Latest model config from request/header events (log-only snapshots).
      let latestConfig
      let configCount = 0
      const configs = new Map()
      for (const ev of events) {
        if (ev.type !== 'request/header') continue
        const cfg = ev.data && ev.data.header && ev.data.header.config
        if (!cfg) continue
        latestConfig = cfg
        configCount += 1
        const key = JSON.stringify([cfg.provider, cfg.model, cfg.reasoningEffort ?? null, cfg.temperature ?? null, cfg.maxTokens ?? null])
        configs.set(key, (configs.get(key) ?? 0) + 1)
      }

      // Build the transcript window: noise (streaming chunks, log-only
      // bookkeeping) is filtered first, then limit/since_turn apply to
      // meaningful events only.
      const window = selectEventWindow(events, { limit, sinceTurn })
      const lines = []
      let used = 0
      const push = (line) => {
        const text = String(line)
        if (used + text.length > totalBudget) return false
        lines.push(text)
        used += text.length
        return true
      }

      for (const ev of window) {
        let rendered
        switch (ev.type) {
          case 'turn/start':
            rendered = `turn ${ev.data.turn} start`
            break
          case 'turn/end': {
            const reason = ev.data.reason || {}
            let line = `turn ${ev.data.turn} end: ${reason.kind ?? 'unknown'}`
            if (reason.kind === 'error' && reason.error) {
              line += ` (${reason.error.code ?? 'UNKNOWN'}: ${clip(String(reason.error.message ?? ''), 200)})`
            }
            if (reason.kind === 'aborted' && reason.reason) {
              line += ` (cause=${reason.reason.kind ?? 'unknown'})`
            }
            rendered = line
            break
          }
          case 'step/start':
            rendered = `  step ${ev.data.step} start`
            break
          case 'step/end':
            rendered = `  step ${ev.data.step} end`
            break
          case 'user/message': {
            const msg = ev.data
            const kind = msg.source && msg.source.kind ? msg.source.kind : 'user'
            rendered = `user [${kind}]: ${clip(textOfBlocks(msg.content), blockChars)}`
            break
          }
          case 'assistant/message': {
            const msg = ev.data.message
            const blocks = Array.isArray(msg.content) ? msg.content : []
            const text = textOfBlocks(blocks)
            const reasoningLen = textLengthOf(blocks.filter((b) => b.type === 'reasoning'))
            const toolCalls = blocks.filter((b) => b.type === 'tool-call')
            let line = `assistant: ${clip(text, blockChars)}`
            if (reasoningLen > 0) {
              if (includeReasoning) {
                const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('')
                line += `\n  reasoning: ${clip(reasoning, blockChars)}`
              } else {
                line += `\n  reasoning: ${reasoningLen} chars (hidden; pass include_reasoning=true)`
              }
            }
            for (const tc of toolCalls) {
              line += `\n  -> tool call ${tc.name}(${clip(tc.arguments, 300)})`
            }
            rendered = line
            break
          }
          case 'tool/result': {
            const msg = ev.data.message
            const err = ev.data.error
            const text = clip(textOfBlocks(msg && msg.content ? msg.content : []), blockChars)
            rendered = `  tool result${ev.data.isError !== undefined && ev.data.isError ? ' [error]' : err ? ` [error ${err.code ?? ''}]` : ''}: ${text}`
            break
          }
          default:
            rendered = undefined
        }
        if (rendered !== undefined && !push(rendered)) break
      }
      if (sinceTurn !== undefined && lines.length === 0) push(`(no events from turn ${sinceTurn} onward)`)

      // Pending queue summary.
      let pendingSummary
      const liveChild = ctx.agents.get(childId)
      if (liveChild) {
        pendingSummary = {
          nextTurn: liveChild.inbox.nextTurn.length,
          nextStep: liveChild.inbox.nextStep.length,
          resident: true,
        }
      } else {
        const folded = foldPendingInbox(events)
        pendingSummary = {
          nextTurn: folded['next-turn'].length,
          nextStep: folded['next-step'].length,
          resident: false,
        }
      }

      // Live children can report the preset their composition ACTUALLY runs on
      // (composedPreset reflects a creation-window re-link; the session header
      // would still name the parent's preset and is not shown for cold reads).
      const presets = ctx.get('agentPresets')
      let composedPreset
      if (live && presets && typeof presets.composedPreset === 'function') {
        composedPreset = presets.composedPreset(liveChild.ctx)
      }

      // Settlement record from the in-process registry (covers children whose
      // settlement notice was lost; the durable log tail also shows turn/end).
      const settlement = settled.get(childId)

      return definedOnly({
        subagent_id: childId,
        status,
        resident: live,
        agent_preset: composedPreset,
        settlement: settlement
          ? {
              stopReason: settlement.stopReason,
              at: settlement.at,
              summary: settlementSummaryOf(childId, settlement.stopReason, settlement.closingText),
              ...(settlement.closingText !== undefined ? { closingText: settlement.closingText } : {}),
            }
          : undefined,
        effective_config: latestConfig
          ? {
              provider: latestConfig.provider,
              model: latestConfig.model,
              ...(latestConfig.reasoningEffort !== undefined ? { reasoningEffort: latestConfig.reasoningEffort } : {}),
              ...(latestConfig.temperature !== undefined ? { temperature: latestConfig.temperature } : {}),
              ...(latestConfig.maxTokens !== undefined ? { maxTokens: latestConfig.maxTokens } : {}),
            }
          : undefined,
        transcript: lines.join('\n'),
        pending_summary: pendingSummary,
      })
    },
  })))

  /* ---- subagent_config --------------------------------------------- */
  tools.push(ctx.tools.register(defineTool({
    name: 'subagent_config',
    description:
      'Update the model/reasoning configuration of one of your continuable subagents mid-run: provider, model, maxTokens, reasoningEffort, or temperature. ' +
      'The new values apply from the child\'s next model request onward (the effective config is re-logged in its request header). ' +
      'Only non-empty fields change; omitted fields keep their current value. Overrides are process-local: after a process restart a cold-resumed child returns to its inherited route, so re-apply with this tool after it is active again.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The durable subagent id.',
      },
      provider: { type: 'string', description: 'Optional new provider route.' },
      model: { type: 'string', description: 'Optional new model id.' },
      maxTokens: { type: 'integer', description: 'Optional new maximum output tokens per request.' },
      reasoningEffort: { type: 'string', description: 'Optional new reasoning intensity (adapter-dependent effort id).' },
      temperature: { type: 'number', description: 'Optional new sampling temperature.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subagent_id: { type: 'string', required: true },
          applied: { type: 'object', additionalProperties: true, properties: {} },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `config for subagent ${value.subagent_id}: ${JSON.stringify(value.applied)}`,
      }],
    },
    async execute(args, exec) {
      const parent = requireCaller(exec)
      const childId = String(args.subagent_id)
      await assertAncestor(ctx, parent, childId, exec.signal)
      if (args.agent_preset !== undefined && args.agent_preset !== '') {
        throw new Error('agentPreset can only be set at creation time (subagent_run); switching presets mid-conversation would leave logged tool calls the new composition cannot make')
      }
      const merged = mergeOverrides(overrides.get(childId), args)
      if (Object.keys(merged).length === 0) {
        return {
          subagent_id: childId,
          applied: {},
          note: 'no non-empty override fields supplied; nothing changed',
        }
      }
      // Fail fast: the merged route (args > existing overrides > parent) must
      // accept the requested reasoning effort before the registry changes.
      await checkReasoningEffort(ctx, resolveEffectiveRoute(args, parent.options, merged), args.reasoningEffort, exec.signal)
      overrides.set(childId, merged)
      persistOverrides()
      return {
        subagent_id: childId,
        applied: merged,
        note: 'applies from the child\'s next model request (agent/request waterfall); persisted; verify with subagent_probe',
      }
    },
  })))

  /* ---- subagent_wait ------------------------------------------------ */
  tools.push(ctx.tools.register(defineTool({
    name: 'subagent_wait',
    description:
      'Wait inside the CURRENT turn for one or more of your continuable subagents to settle, returning each finished child\'s terminal state and closing output. ' +
      'Already-settled children (this process) resolve immediately; resident children are awaited via the subagent/end event; cold children are classified from their durable log ' +
      '(settled children resolve from the log; children with queued work or an open turn fail with guidance to wake them first). ' +
      'On timeout the settled subset is returned with timed_out=true. Use this instead of ending your turn and relying on the settlement notice, which can be lost ' +
      'when your turn is interrupted or the notice cannot reach you.',
    parameters: {
      subagent_ids: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Durable subagent ids to wait for (pass a single-element array for one child).',
      },
      timeout_seconds: {
        type: 'integer',
        description: 'How long to wait before returning timed_out=true (default 60, max 600).',
      },
      require: {
        type: 'string',
        enum: ['all', 'any'],
        description: 'all (default) waits for every child; any returns as soon as one settles.',
      },
      max_chars: {
        type: 'integer',
        description: 'Closing-output truncation budget per child (default 2000).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          settled: {
            type: 'array',
            required: true,
            items: { type: 'json' },
          },
          timed_out: { type: 'boolean', required: true },
          elapsed_ms: { type: 'number', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.settled.length === 0
          ? `wait timed out after ${value.elapsed_ms}ms (no child settled)`
          : `${value.settled.map((s) => `${s.subagent_id}: ${s.stopReason}`).join('\n')}${value.timed_out ? `\n(timed out after ${value.elapsed_ms}ms; ${args.subagent_ids.length - value.settled.length} child(ren) still running)` : ''}`,
      }],
    },
    async execute(args, exec) {
      const parent = requireCaller(exec)
      const ids = (args.subagent_ids || []).map(String)
      if (ids.length === 0) throw new Error('subagent_wait requires at least one subagent id')
      const timeoutMs = Math.max(1, Math.min(args.timeout_seconds ?? 60, 600)) * 1000
      const requireAll = (args.require ?? 'all') !== 'any'
      const maxChars = args.max_chars ?? 2000
      for (const id of ids) await assertAncestor(ctx, parent, id, exec.signal)
      const startedAt = Date.now()

      const results = new Map()
      const remaining = new Set()

      for (const id of ids) {
        // 1) already settled in this process
        const rec = settled.get(id)
        if (rec !== undefined) {
          results.set(id, {
            stopReason: rec.stopReason,
            summary: settlementSummaryOf(id, rec.stopReason, rec.closingText),
            ...(rec.closingText !== undefined ? { closingText: rec.closingText } : {}),
          })
          continue
        }
        // 2) resident: await subagent/end below
        if (ctx.agents.get(id) !== undefined) {
          remaining.add(id)
          continue
        }
        // 3) cold: classify from the durable log
        const { events } = await readChildSession(ctx, id, exec.signal)
        const pending = foldPendingInbox(events)
        const state = classifySettlement(events, {
          nextTurn: pending['next-turn'].length,
          nextStep: pending['next-step'].length,
        })
        if (state === 'settled') {
          const text = finalOutputOf(events, maxChars)
          const stopReason = terminalReasonOf(events) ?? 'completed'
          results.set(id, {
            stopReason,
            summary: settlementSummaryOf(id, stopReason, text),
            ...(text !== '' ? { closingText: text } : {}),
          })
          continue
        }
        if (state === 'unknown') {
          throw new Error(`subagent ${id} has no turn history; nothing to wait for`)
        }
        throw new Error(`subagent ${id} is not resident and still has ${state === 'queued' ? 'queued inbox work' : 'an open turn'}; use subagent_send followup to wake it, then wait again`)
      }

      if (remaining.size > 0) {
        // Wait via the global waiter table (fed by the same subagent/end
        // listener that writes the settled registry). NO dynamic ctx.on/ctx.off
        // during tool execution: cordis has no ctx.off, and a throw inside the
        // timeout callback used to become an uncaughtException that killed the
        // whole process.
        await new Promise((resolve) => {
          let done = false
          let timer
          const unregisters = []
          const finish = () => {
            if (done) return
            done = true
            clearTimeout(timer)
            for (const unregister of unregisters.splice(0)) {
              try { unregister() } catch { /* containment: cleanup must not block resolve */ }
            }
            resolve()
          }
          const onSettled = (key) => {
            if (!remaining.has(key)) return
            remaining.delete(key)
            const rec = settled.get(key)
            if (rec !== undefined) {
              results.set(key, {
                stopReason: rec.stopReason,
                summary: settlementSummaryOf(key, rec.stopReason, rec.closingText),
                ...(rec.closingText !== undefined ? { closingText: rec.closingText } : {}),
              })
            }
            if (!requireAll || remaining.size === 0) finish()
          }
          for (const id of remaining) {
            unregisters.push(registerWaiter(waiters, id, () => onSettled(id)))
          }
          timer = setTimeout(() => {
            try { finish() } catch (error) {
              ctx.logger.warn(`dsh-subagent-supervisor: subagent_wait timeout cleanup error: ${String(error)}`)
              try { resolve() } catch { /* containment */ }
            }
          }, timeoutMs)
          if (exec.signal && typeof exec.signal.addEventListener === 'function' && !exec.signal.aborted) {
            exec.signal.addEventListener('abort', () => { try { finish() } catch { /* containment */ } }, { once: true })
          } else if (exec.signal && exec.signal.aborted) {
            try { finish() } catch { /* containment */ }
          }
        })
      }

      const settledRows = ids
        .filter((id) => results.has(id))
        .map((id) => ({ subagent_id: id, ...results.get(id) }))
      return {
        settled: settledRows,
        timed_out: remaining.size > 0,
        elapsed_ms: Date.now() - startedAt,
      }
    },
  })))

  // Effect-scoped teardown for anything cordis does not track automatically.
  ctx.effect(() => () => {
    overrides.clear()
    clearInterval(stallTimer)
    for (const dispose of tools.splice(0)) {
      try { dispose() } catch { /* containment: continue disposing the rest */ }
    }
  })

  /* ---- stall detector -------------------------------------------------- */
  // A running child with no new session event for `stallMinutes` is flagged:
  // the live parent gets one inject reminder (throttled per child) so a
  // silently hung turn no longer leaves the parent waiting unaware. The scan
  // is a cheap in-memory walk; a child that produced events again resets its
  // reminder state.
  const STALL_SCAN_MS = 5 * 60_000
  const stallReminded = new Map()
  function scanStalls() {
    if (!stallReminder) return
    const now = Date.now()
    const thresholdMs = stallMinutes * 60_000
    for (const agent of ctx.agents.list()) {
      try {
        const header = agent.session.header
        if (header.origin !== 'subagent' || agent.status !== 'running') continue
        const events = agent.session.events
        const last = events.length > 0 ? events[events.length - 1] : undefined
        const lastTime = last && typeof last.time === 'number' ? last.time : undefined
        if (lastTime === undefined) continue
        const childId = String(agent.id)
        if (now - lastTime < thresholdMs) {
          stallReminded.delete(childId) // activity resumed: reset the reminder
          continue
        }
        const lastReminded = stallReminded.get(childId)
        if (lastReminded !== undefined && now - lastReminded < thresholdMs * 2) continue
        const parent = ctx.agents.get(header.parentSession)
        if (parent === undefined) continue
        const minutes = Math.round((now - lastTime) / 60_000)
        const reminder = `子代理 ${childId} 已约 ${minutes} 分钟没有新活动（可能仍在处理长请求，也可能卡住）。可用 subagent_probe 检查；必要时用 subagent_send (cancel_first) 重定向，或用 subagent_queue 清理排队消息。`
        parent.inject(createUserMessage({
          content: [{ type: 'text', text: reminder }],
          source: { kind: 'plugin', plugin: name, form: 'relay' },
        }))
        stallReminded.set(childId, now)
        if (stallReminded.size > SETTLED_MAX) stallReminded.delete(stallReminded.keys().next().value)
      } catch (error) {
        ctx.logger.warn(`dsh-subagent-supervisor: stall scan error: ${String(error)}`)
      }
    }
  }
  const stallTimer = setInterval(scanStalls, STALL_SCAN_MS)

  /* ---- browser children-config endpoint -------------------------------- */
  // Serves the per-child settings the Web panel shows (model / reasoning /
  // preset) in ONE request: the override registry + live composedPreset.
  // Same-origin loopback posture as the dsh-restart endpoint; the data is the
  // child config the parent itself set, no credentials.
  const webServer = ctx.webServer
  const CATALOG_CACHE_MS = 60_000
  let catalogCache // {ts, entries} — listChildren is a durable scan; cache it
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-subagent-supervisor/children-config',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' })
            res.end('method not allowed')
            return
          }
          const url = new URL(req.url ?? '/', 'http://x')
          const parent = url.searchParams.get('parent')
          if (!parent) {
            res.writeHead(400)
            res.end('missing parent session id')
            return
          }
          const fresh = url.searchParams.get('fresh') === '1'
          const presets = ctx.get('agentPresets')
          const composedPresetOf = presets && typeof presets.composedPreset === 'function'
            ? (agent) => {
                try { return presets.composedPreset(agent.ctx) } catch { return undefined }
              }
            : undefined
          const liveRows = buildChildrenConfig(parent, ctx.agents.list(), overrides, composedPresetOf)
          // Cold children (settled/ready) are not in the live registry; the
          // durable catalog supplies them and the override registry their config.
          // The catalog scan is cached (60s) so the panel's 5s polling does not
          // rescan durable sessions every tick; `fresh=1` bypasses the cache.
          let catalog
          const now = Date.now()
          if (!fresh && catalogCache !== undefined && now - catalogCache.ts < CATALOG_CACHE_MS) {
            catalog = catalogCache.entries
          } else if (typeof ctx.subagents.listChildren === 'function') {
            catalog = await ctx.subagents.listChildren(parent)
            catalogCache = { ts: now, entries: catalog }
          } else {
            catalog = []
          }
          // Cold preset truth: a cold child WITHOUT an explicit override will
          // resume on the PARENT's current preset (cold resume composes from
          // the live parent), so the parent's composed preset is the accurate,
          // zero-cost answer — no per-session reads on the polling path.
          const parentAgent = ctx.agents.get(parent)
          const parentPreset = parentAgent !== undefined && composedPresetOf !== undefined
            ? composedPresetOf(parentAgent)
            : undefined
          const rows = mergeColdChildren(liveRows, catalog, overrides, undefined, parentPreset)
          // Effective model/reasoning per child: explicit override wins, else
          // the child's own last request header (live) or the parent's header
          // (the inherited source for cold children) — the panel shows these
          // actual values instead of a bare "inherited" label.
          const parentHeader = parentAgent !== undefined && typeof parentAgent.session.requestHeader === 'function'
            ? parentAgent.session.requestHeader()
            : undefined
          const parentEff = parentHeader ? parentHeader.config : undefined
          for (const row of rows) {
            const liveAgent = ctx.agents.get(row.id)
            let effSource = parentEff
            if (liveAgent !== undefined && typeof liveAgent.session.requestHeader === 'function') {
              const header = liveAgent.session.requestHeader()
              if (header && header.config) effSource = header.config
            }
            row.effective = resolveEffectiveDisplay(row.settings, effSource)
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ children: rows }))
        } catch (error) {
          res.writeHead(500)
          res.end(String(error))
        }
      },
    }), 'dsh-subagent-supervisor: children-config endpoint')
  }
}

// Testable pure helpers (module surface only; the runtime entry is apply()).
export {
  Config,
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
}

export default { name, inject, apply }
