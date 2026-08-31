/**
 * dsh-subagent-supervisor — core version adaptation helpers.
 *
 * Verified auto-compat targets (the peer range mirrors these):
 *   - @deepseek-ai/dsh 0.1.1-rc.2    (rc.2 line; current desktop bundle)
 *   - @deepseek-ai/dsh 0.1.2-alpha.1 (alpha line; client module system rewritten,
 *                                     ApiProxy retired)
 *   - @deepseek-ai/dsh 0.1.2-alpha.2 (alpha line; ApiProxy fully removed,
 *                                     SessionEvent.ignorable restored)
 *
 * Host-side surfaces this plugin imports (dsh-tools `defineTool`,
 * dsh-llm/message `createUserMessage`/`freezeMessage`) exist on all three
 * lines, so the host plane needs no code branch — the peer range is the only
 * install-level gate. The web panel additionally requires the rc.2 client
 * runtime (the 'slots'/'connection' require faces; `ctx.connection.api` is the
 * legacy ApiProxy client), which the alpha line removed, so the client half
 * probes its faces at boot and degrades there (see lib/client.js).
 *
 * Everything here is pure (or best-effort I/O) so tests can lock the mapping
 * without a live harness.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Core generation labels. */
export const CORE_RC2 = 'rc2'
export const CORE_ALPHA = 'alpha'
export const CORE_UNKNOWN = 'unknown'

/** The supported core version strings (official tags). */
export const SUPPORTED_CORE_VERSIONS = ['0.1.1-rc.2', '0.1.2-alpha.1', '0.1.2-alpha.2']

/**
 * Classify a core version string into a generation.
 * @param {string|null|undefined} version
 * @returns {'rc2'|'alpha'|'unknown'}
 */
export function classifyCore(version) {
  if (typeof version !== 'string' || version === '') return CORE_UNKNOWN
  if (/^0\.1\.1-rc\.2$/.test(version)) return CORE_RC2
  if (/^0\.1\.2-alpha\./.test(version)) return CORE_ALPHA
  return CORE_UNKNOWN
}

/** True when the version is one of the verified compatibility targets. */
export function isSupportedCore(version) {
  return classifyCore(version) === CORE_RC2 || classifyCore(version) === CORE_ALPHA
}

/**
 * Client-side capability summary per core generation (diagnostics only; the
 * client half always probes live faces, never this table alone):
 *  - generation:          rc2 | alpha | unknown
 *  - legacyClientRuntime: the `@deepseek-ai/dsh-client-runtime` bundle that
 *    supplies the 'slots'/'connection' require faces (renamed
 *    `dsh-client-modules` on the alpha line).
 *  - apiProxyClient:      the legacy ApiProxy client (`ctx.connection.api` /
 *    `api.<domain>.*`), retired on alpha.1 and removed on alpha.2.
 */
export function clientCapabilities(version) {
  const generation = classifyCore(version)
  return {
    generation,
    legacyClientRuntime: generation === CORE_RC2,
    apiProxyClient: generation === CORE_RC2,
  }
}

/**
 * Where the settings registration API lives per line (diagnostics only; the
 * runtime probe in classifySettingsModule is authoritative):
 *   - 'legacy-function': the `installSettingsSection` free function
 *     (0.1.1-rc.2 and 0.1.2-alpha.1).
 *   - 'provider':        the SettingsProvider service method `installSection`
 *     (0.1.2-alpha.2, where the free function was removed).
 */
export function settingsInstallKind(version) {
  if (/^0\.1\.2-alpha\.1$/.test(version)) return 'legacy-function'
  if (/^0\.1\.2-alpha\./.test(version)) return 'provider'
  return 'legacy-function'
}

/**
 * Classify an already-loaded @deepseek-ai/dsh-settings module by its actual
 * export shape — the authoritative auto-compat probe (adapts to whatever core
 * version is installed without a hard-coded version list).
 * @param {object|null|undefined} mod  dynamic-import result, or null on failure
 * @param {Error|unknown} [error]      original import error
 * @returns {{mode:'legacy-function'|'provider-class'|'none'|'unavailable', mod, error}}
 */
export function classifySettingsModule(mod, error) {
  if (!mod) return { mode: 'unavailable', mod: null, error }
  if (typeof mod.installSettingsSection === 'function') return { mode: 'legacy-function', mod, error }
  if (typeof mod.default === 'function') return { mode: 'provider-class', mod, error }
  return { mode: 'none', mod, error }
}

/**
 * Best-effort detection of the installed core line by reading the version of a
 * peer package this plugin already depends on. Returns null when nothing
 * resolves (unusual layouts, tests) — callers treat null as 'unknown'.
 */
export function detectCoreVersion() {
  // Resolve the peer package's MAIN entry (always allowed by the exports map)
  // and read the adjacent package.json — robust regardless of whether the
  // map exposes './package.json'.
  const require = createRequire(import.meta.url)
  for (const spec of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh']) {
    try {
      const entry = require.resolve(spec)
      const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'))
      if (pkg && typeof pkg.version === 'string') return pkg.version
    } catch {
      // try the next spec
    }
  }
  return null
}