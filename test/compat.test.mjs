/**
 * Cross-version auto-compat tests — dsh-subagent-supervisor.
 *
 * Verified targets: @deepseek-ai/dsh 0.1.1-rc.2 · 0.1.2-alpha.1 · 0.1.2-alpha.2.
 *  1. peerDependencies must accept all three core lines (and reject 0.2.x).
 *  2. compat classification / capability tables must match the researched
 *     breakages (dsh-client-runtime → dsh-client-modules, ApiProxy removal).
 *  3. client boot guard: the web panel activates on rc.2 faces and degrades
 *     (skips, warns) on alpha-line faces instead of crashing the shell.
 *
 * Run: node --test test/compat.test.mjs   (or `npm test`)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

import {
  classifyCore, isSupportedCore, clientCapabilities, settingsInstallKind,
  classifySettingsModule, detectCoreVersion, CORE_RC2, CORE_ALPHA, CORE_UNKNOWN,
} from '../lib/compat.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TARGETS = ['0.1.1-rc.2', '0.1.2-alpha.1', '0.1.2-alpha.2']
const CANONICAL_PEER_RANGE = '>=0.1.1-rc.2 <0.2.0 || >=0.1.2-alpha.1 <0.2.0'

/** Prefer the machine's semver (npm-bundled or the dsh checkout store). */
function loadSemver() {
  const here = createRequire(import.meta.url)
  try { return here('semver') } catch { /* try next */ }
  const appdata = process.env.APPDATA
  if (appdata) {
    const dir = join(appdata, 'io.github.hairyf.deepseek-harness-desktop', 'dependencies', 'dsh', 'node_modules', 'semver')
    try { return createRequire(pathToFileURL(join(dir, 'package.json')))(dir) } catch { /* try next */ }
  }
  return null
}

test('peerDependencies: one canonical range covers all three core lines', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  const ranges = Object.values(pkg.peerDependencies || {})
  assert.ok(ranges.length >= 2, 'plugin must declare peer ranges')
  for (const r of ranges) assert.equal(r, CANONICAL_PEER_RANGE, `unexpected peer range ${r}`)
  const semver = loadSemver()
  if (!semver) {
    console.warn('(semver not resolvable on this machine; canonical-string contract checked only)')
    return
  }
  for (const v of TARGETS) {
    assert.ok(semver.satisfies(v, CANONICAL_PEER_RANGE), `${v} must satisfy ${CANONICAL_PEER_RANGE}`)
  }
  for (const v of ['0.1.1-rc.1', '0.1.2-alpha.0', '0.1.3-alpha.1', '0.2.0', '0.2.0-rc.1']) {
    assert.equal(semver.satisfies(v, CANONICAL_PEER_RANGE), false, `${v} must NOT satisfy ${CANONICAL_PEER_RANGE}`)
  }
})

test('classifyCore maps the three targets and rejects others', () => {
  assert.equal(classifyCore('0.1.1-rc.2'), CORE_RC2)
  assert.equal(classifyCore('0.1.2-alpha.1'), CORE_ALPHA)
  assert.equal(classifyCore('0.1.2-alpha.2'), CORE_ALPHA)
  assert.equal(classifyCore('0.2.0'), CORE_UNKNOWN)
  assert.equal(classifyCore(null), CORE_UNKNOWN)
  assert.equal(classifyCore(''), CORE_UNKNOWN)
  for (const v of TARGETS) assert.equal(isSupportedCore(v), true)
  assert.equal(isSupportedCore('0.2.0'), false)
})

test('clientCapabilities: legacy client faces exist only on the rc.2 line', () => {
  assert.deepEqual(clientCapabilities('0.1.1-rc.2'), { generation: CORE_RC2, legacyClientRuntime: true, apiProxyClient: true })
  assert.deepEqual(clientCapabilities('0.1.2-alpha.1'), { generation: CORE_ALPHA, legacyClientRuntime: false, apiProxyClient: false })
  assert.deepEqual(clientCapabilities('0.1.2-alpha.2'), { generation: CORE_ALPHA, legacyClientRuntime: false, apiProxyClient: false })
})

test('settingsInstallKind: free function until alpha.2 becomes provider service', () => {
  assert.equal(settingsInstallKind('0.1.1-rc.2'), 'legacy-function')
  assert.equal(settingsInstallKind('0.1.2-alpha.1'), 'legacy-function')
  assert.equal(settingsInstallKind('0.1.2-alpha.2'), 'provider')
})

test('classifySettingsModule probes the real module shape', () => {
  assert.equal(classifySettingsModule(null).mode, 'unavailable')
  assert.equal(classifySettingsModule(undefined).mode, 'unavailable')
  assert.equal(classifySettingsModule({ installSettingsSection: () => {}, settingsNamespace: () => {} }).mode, 'legacy-function')
  assert.equal(classifySettingsModule({ default: class DummyProvider {} }).mode, 'provider-class')
  assert.equal(classifySettingsModule({}).mode, 'none')
})

test('detectCoreVersion never throws and returns a plausible answer', () => {
  const v = detectCoreVersion()
  assert.ok(v === null || /^0\.1\./.test(v), `unexpected core version: ${String(v)}`)
})

/* ---------------------------------------------------------------- *
 * Client boot guard — the bundle is loaded through a stubbed
 * window.__ModuleLoader__ and the factory is driven with fake faces.
 * ---------------------------------------------------------------- */

const bundle = await (async () => {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (o) => { captured = o } } }
  await import(pathToFileURL(join(__dirname, '..', 'lib', 'client.js')).href)
  assert.ok(captured, 'client bundle must register with __ModuleLoader__')
  return captured
})()

function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    memo: (c) => c,
    Component: class {},
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (f) => f,
    useRef: () => ({}),
    useSyncExternalStore: (subscribe, get) => get(),
  }
}
function factoryRequire() {
  const react = reactStub()
  return (name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require in client bundle: ${name}`)
  }
}

const warns = []
const realWarn = console.warn
function captureWarns() { warns.length = 0; console.warn = (...a) => { warns.push(a.map(String).join(' ')) } }
function restoreWarns() { console.warn = realWarn }

test('rc.2 faces → conversation.view panel registers, no warning', () => {
  const mod = bundle.factory(factoryRequire())
  const injected = []
  const ctx = {
    slots: {
      inject: (name, cb) => injected.push({ name, cb }),
      register: (spec, comp) => ({ spec, comp }),
    },
    connection: { api: { subagents: {} } },
  }
  captureWarns()
  assert.doesNotThrow(() => mod.apply(ctx))
  restoreWarns()
  assert.equal(injected.length, 1)
  assert.equal(injected[0].name, 'conversation.view')
  const registered = injected[0].cb()
  assert.equal(registered.spec.id, 'subagent-supervisor')
  assert.equal(warns.length, 0)
})

test('alpha.1 faces (connection without api proxy) → panel skipped, host unaffected', () => {
  const mod = bundle.factory(factoryRequire())
  const injected = []
  const ctx = {
    slots: { inject: (name) => injected.push(name), register: () => ({}) },
    connection: {}, // connection face present on alpha but ApiProxy client gone
  }
  captureWarns()
  assert.doesNotThrow(() => mod.apply(ctx))
  restoreWarns()
  assert.equal(injected.length, 0)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /skipped/)
})

test('alpha.2 faces (no slots face at all) → panel skipped without crash', () => {
  const mod = bundle.factory(factoryRequire())
  captureWarns()
  assert.doesNotThrow(() => mod.apply({}))
  restoreWarns()
  assert.equal(warns.length, 1)
  assert.match(warns[0], /skipped/)
})