# dsh-subagent-supervisor

Host-plane subagent supervision tools for the DeepSeek Harness main agent,
plus a web supervision panel. Fills four gaps in the shipped subagent tooling
(verified against rc.7):

| Gap | Tool | Mechanism |
| --- | --- | --- |
| 1. Per-call model / reasoning settings for children | `subagent_run`, `subagent_config` | per-call `AgentOptions` through `ctx.subagents.startContinuable()` + a per-child `agent/request` waterfall installed by `registerContinuableSetup` (applies `reasoningEffort` / `temperature` / `maxTokens` / `provider` / `model` from the child's first request onward, on fresh creation AND cold resume) |
| 2. Mid-turn "插话" delivery | `subagent_send` (modes `followup` / `inject` / `steer`, optional `cancel_first`) | `followup` = FIFO next turn (cold-resume capable, service-authorized); `steer` / `inject` = the Agent API's `next-step` inbox boundary (running child consumes at its next step boundary inside the current turn); `cancel_first` = `subagents.interrupt()` (keepInbox) first |
| 3. Message queue management | `subagent_queue` (list / remove / clear) | live `Agent.inbox` for resident children (durable via `agent/inbox/spliced`), log-folded reconstruction for cold children |
| 4. Step-by-step inspection | `subagent_probe` | status + effective model config (`request/header`) + transcript window (turns/steps, user messages, assistant text & reasoning, tool calls/results, errors) + pending queue summary, from the live session or the persisted log |

## Enhancements (v0.2)

- **① reasoningEffort adapter pre-validation** — `subagent_run` / `subagent_config`
  resolve the effective route (args > overrides > parent) and check the
  requested effort against `llm.resolveModelInfo(...).reasoning.efforts`
  BEFORE delegating: an unsupported effort fails fast with the supported list
  instead of starting a doomed child. When the adapter exposes no effort
  metadata the check passes through (the child failure would still surface via
  probe). E.g. modlens-opencode-go exposes `[off, high, max]`.
- **② override registry persistence** — the registry is stored at
  `$DSH_HOME/subagent-supervisor/overrides.json` (atomic tmp+rename, serialized
  writes, best-effort). Loaded at plugin start, so a cold-resumed child after a
  process restart automatically inherits its configuration — no need to re-run
  `subagent_config`.
- **③ web supervision panel** — a "子代理" tab in the conversation view
  (`conversation.view`, order 20) lists the current session's direct subagents
  and shows the selected child's transcript with older-page loading; you can
  queue a message (FIFO followup via `api.subagents.prompt`) and interrupt
  (`api.subagents.interrupt`) for continuable children. Powered by the
  official `api.subagents.*` Remote API plus one plugin endpoint
  (`/plugins/dsh-subagent-supervisor/children-config`) that supplies each
  child's SET model / reasoning effort / Agent preset as three tags on every
  list row (and in the detail header) — live children report the composed
  preset truth; cold children report the explicit override, else the parent's
  current preset (exactly what a cold resume would inherit — never a bare
  "inherited" label). The endpoint caches its durable catalog scan for 60s
  (first call ~1s, cached calls ~1ms; the manual 刷新 button bypasses via
  `fresh=1`). one-shot children are read-only; the panel is session-scoped and
  renders nothing without a session. steer/inject remain exclusive to the
  model-side tools (the browser channel is the human channel by design).
  Performance: memoized list rows, in-flight guard, per-child history cache
  with instant re-select, 400-row
  transcript cap, and history polling only for the selected running child.
- **④ per-child Agent preset** — `subagent_run {agent_preset: '<id>'}` composes
  the child from a chosen preset (shipped `standard`/`code`/`minimal`/`cordis`,
  or locally authored ids under `~/.dsh/.agent-presets`, e.g. the bohrium-*
  roles). Unknown or unusable presets fail the call before the child starts.
  The preset choice rides the persisted override registry, so a cold-resumed
  child after a restart automatically restores its preset. Mechanism: the child
  initially inherits the parent's composition, then a per-child
  `agent/pre-step` listener re-links it to the target preset's standing
  composition BEFORE its first request assembles system/tools
  (`agentPresets.recompose`). Grandchildren inherit the child's (re-linked)
  composition. `subagent_config` rejects preset changes mid-run (a mid
  conversation tool swap would leave logged tool calls the new composition
  cannot make). Known limitation: the session header still records the parent's
  preset id — runtime composition is correct and probe reports the truth via
  `agent_preset` (live children only); only third-party reads that trust the
  header could show a stale preset.
- **⑤ settlement closure** — three layers so a finished child never leaves the
  parent waiting unaware:
  - `subagent_wait {subagent_ids, timeout_seconds?, require?}` waits inside the
    CURRENT turn for children to settle and returns each one's terminal state
    (`stopReason` extracted from the log for cold children, e.g. `interrupted`
    after a crash) plus its closing output. Already-settled children resolve
    immediately from the in-process registry; cold children are classified from
    their durable log (children with queued work or an open turn fail with
    guidance to wake them first); on timeout the settled subset returns with
    `timed_out: true`.
  - `subagent_probe` gained a `settlement` field (`stopReason`/`at`/`summary`/
    `closingText`) backed by an in-process registry fed by `subagent/end` — the
    parent can always *query* "is it done and what did it say", even when the
    settlement notice itself was lost (parent not live, parent turn aborted
    with pending steering cleared, or a delivery exception).
  - stall detector (Config: `stallMinutes` default 15, `stallReminder` default
    true): a running child with no new session event past the threshold gets
    one throttled inject reminder to its live parent.
  - Environment caveat observed in this deployment: long tool executions
    (including `subagent_wait`'s live wait) can be interrupted by an
    environment-level automatic harness restart. Prefer short wait timeouts
    with re-query, or rely on the settlement notice when idle (idle parents
    are woken reliably via followup) plus probe for verification.

## Install

Point pnpm at the checked-out source (adjust the path to your clone):

```powershell
pnpm --dir $env:DSH_HOME\profiles\web add file:<path-to-this-repo>
```

Mount on the **host plane** in `$env:DSH_HOME\profiles\web\cordis.patch.yml`
(the row must NOT live inside a preset: `registerContinuableSetup` is a process
singleton and one copy per preset would install every child twice):

```yaml
- insert:
    - id: subagent-supervisor
      name: dsh-subagent-supervisor
```

The client half is auto-discovered via the package's `dsh.client` declaration
and served at `/plugins/dsh-subagent-supervisor/client.js`; the browser picks
it up after a page refresh.

> **Note**: `pnpm add file:` COPIES the package (hoisted linker). After editing
> the source, re-run the `pnpm add` command to re-sync the copy, then restart
> the harness.

> **Fixed (v0.2.1)**: `subagent_wait` previously called `ctx.off(...)` inside its
> timeout/listener cleanup — cordis exposes `ctx.on` with a disposer and has NO
> `ctx.off`, so the timeout callback threw a TypeError that became an
> `uncaughtException` and **killed the whole DSH process** (the "服务挂掉"
> symptom). The live wait now uses a global waiter table fed by the plugin's
> single `subagent/end` listener (no dynamic listener registration), and all
> cleanup callbacks are exception-contained. The continuable-child setup
> disposers were fixed the same way.

Restart the harness. Verify: `dsh --profile web --dump-config` shows the row,
the five `subagent_*` tools appear in the main agent's catalog, and the
conversation view shows the 子代理 tab after a page refresh.

## Tools

- **subagent_run** `{description, prompt, provider?, model?, maxTokens?, reasoningEffort?, temperature?, agent_preset?}`
  → starts a continuable child with the given route and (optionally) Agent
  preset; returns `{subagentId, messageId, applied}`.
  Omitted fields inherit the parent's route/preset.
- **subagent_send** `{subagent_id, message, mode?: followup|inject|steer, cancel_first?: boolean}`
  → delivery confirmation only (never the child's answer). **Default mode is
  `steer`** (interrupt-style, consumed inside the running child's current
  turn); when no mode is given and the child is not resident, the delivery
  automatically falls back to `followup` so cold resume keeps working (the
  returned `mode` reports what was actually used). `steer` cannot interrupt an
  in-flight model request or tool execution (architecture limit);
  combine with `cancel_first: true` for the "long single step" case.
- **subagent_queue** `{subagent_id, action: list|remove|clear, message_id?}`
  → `remove`/`clear` require a resident child; `list` also works for cold children.
- **subagent_probe** `{subagent_id, limit?, since_turn?, include_reasoning?, max_chars?}`
  → status, effective config, actual preset, settlement record, transcript window,
  pending queue summary. Works for cold children.
- **subagent_config** `{subagent_id, provider?, model?, maxTokens?, reasoningEffort?, temperature?}`
  → mid-run override update; applies at the child's next model request.
- **subagent_wait** `{subagent_ids, timeout_seconds?, require?: all|any, max_chars?}`
  → waits inside the current turn for children to settle; returns per-child
  `{stopReason, summary, closingText?}` plus `timed_out`. See ⑤ above for the
  three classification paths and the environment caveat.

## Semantics and limits

- **Authorization**: every supervision tool verifies the caller is in the
  target's durable ancestry (`sessionQuery.traceSession`), mirroring the
  continuation manager's `interrupt` rule. Followup delegates to the
  service's own authorized path.
- **Override lifetime**: the registry is persisted to
  `$DSH_HOME/subagent-supervisor/overrides.json` and replayed at startup, so
  follow-up turns AND cold-resumed children after a restart keep their
  configuration (model route, reasoning, preset). Adapter normalization may
  win (e.g. a provider may resolve its own `maxTokens` default) — the probe's
  `effective_config` shows what the log actually recorded.
- **steer timing**: consumed at the child's next step boundary inside the current
  turn. A rejected step parks steering until the next wake; cancellation or
  disposal may discard pending steering (core `Agent.steer` semantics).
- **Cold children**: `followup` and `probe`/`list`/`wait` work; `inject`/`steer`/
  queue mutations require a resident child.
- **Settlement registry**: in-process only (`subagent/end` feed, FIFO 200);
  after a process restart the probe `settlement` field is empty until a new
  settlement happens — the transcript tail (`turn N end: <reason>`) remains the
  durable fallback, and `subagent_wait` reclassifies cold children from the log.
- **stall detector**: default `stallMinutes: 15`, `stallReminder: true`;
  override via the plugin row config in `cordis.patch.yml`.

## Development

- Pure helpers (`clip`, `textOfBlocks`, `textLengthOf`, `mergeOverrides`,
  `foldPendingInbox`, `queueRowOf`, `selectEventWindow`, `definedOnly`,
  `validateEffortAgainstModelInfo`, `resolveEffectiveRoute`,
  `parseOverridesFile`, `serializeOverridesFile`, `resolveOverridesFilePath`)
  are exported for tests:
  `node --test plugins/dsh-subagent-supervisor/test/` from the harness root.
- Rolling back: remove the insert row and `pnpm --dir ... remove dsh-subagent-supervisor`,
  then restart (config snapshots under `~/.dsh/undo` cover `cordis.patch.yml`).
