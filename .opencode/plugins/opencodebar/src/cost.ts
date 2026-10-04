/**
 * Cost aggregation for opencodebar.
 *
 * Pure, dependency-free module (the only import is a type from ./pricing).
 * All OpenCode interaction lives in the TUI layer; these functions operate
 * on plain shapes that mirror the server API:
 * - tokens: { input, output, reasoning, cache: { read, write } } (per message)
 * - time.created: milliseconds since epoch
 */
import type { PriceEntry } from "./pricing"

/** Mirrors the server's TokenUsageInfo. */
export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { read: number; write: number }
}

/** One assistant-message usage record. `variant` is deliberately not modeled. */
export interface UsageInput {
  readonly model: { readonly providerID: string; readonly id: string }
  readonly tokens: TokenUsage
}

export interface CostOptions {
  /** Bill reasoning tokens as output tokens. Default true. */
  readonly includeReasoning?: boolean
}

/**
 * API-equivalent cost of one token usage record.
 *
 * Formula: input*inputPrice + (output+reasoning)*outputPrice
 *        + cache.read*cacheReadPrice + cache.write*cacheWritePrice
 * (LiteLLM prices are USD per single token.)
 *
 * Reasoning tokens ARE billed at the output rate by default. Empirically
 * validated on 2026-10-04 against OpenCode's built-in per-message cost for
 * session ses_efbd93c2cffeNcIuIX2tQPpVrO (opencode-go/mimo-v2.6-pro, priced
 * as LiteLLM xiaomi_mimo/mimo-v2.6-pro: 4.35e-7 / 8.7e-7 / 3.6e-9):
 *   - with reasoning billed as output: $0.039131067 (0.011% off built-in
 *     $0.039135355; per-message deltas ~0.008%)
 *   - with reasoning excluded:        $0.017723847 (55% undercount)
 * OpenCode's tokens.output and tokens.reasoning are disjoint counters, so
 * excluding reasoning would silently drop most of the bill on
 * reasoning-heavy models. Pass { includeReasoning: false } to exclude.
 *
 * A missing entry (unknown model) yields 0 — unknown models never contribute
 * to money totals.
 */
export function computeTokenCost(tokens: TokenUsage, entry: PriceEntry | undefined, options: CostOptions = {}): number {
  if (entry === undefined) return 0
  const output = options.includeReasoning === false ? tokens.output : tokens.output + tokens.reasoning
  return (
    tokens.input * entry.input +
    output * entry.output +
    tokens.cache.read * entry.cacheRead +
    tokens.cache.write * entry.cacheWrite
  )
}

export interface ModelUsage {
  /** `${providerID}/${modelID}` display key. */
  readonly key: string
  readonly providerID: string
  readonly modelID: string
  readonly tokens: TokenUsage
  /** Matched-price cost in USD; 0 when unmatched. */
  readonly usd: number
  readonly matched: boolean
}

export type PriceLookupFn = (providerID: string, modelID: string) => PriceEntry | undefined

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addUsage(target: TokenUsage, source: TokenUsage): TokenUsage {
  return {
    input: target.input + source.input,
    output: target.output + source.output,
    reasoning: target.reasoning + source.reasoning,
    cache: {
      read: target.cache.read + source.cache.read,
      write: target.cache.write + source.cache.write,
    },
  }
}

/**
 * Aggregate usage records per model. Rows are ordered by cost (descending);
 * unmatched models sort after matched ones, alphabetically by key.
 */
export function aggregateModels(usages: Iterable<UsageInput>, lookup: PriceLookupFn): ModelUsage[] {
  const rows = new Map<string, ModelUsage & { tokens: TokenUsage }>()
  for (const usage of usages) {
    const key = `${usage.model.providerID}/${usage.model.id}`
    const entry = lookup(usage.model.providerID, usage.model.id)
    const current = rows.get(key) ?? {
      key,
      providerID: usage.model.providerID,
      modelID: usage.model.id,
      tokens: emptyUsage(),
      usd: 0,
      matched: entry !== undefined,
    }
    const tokens = addUsage(current.tokens, usage.tokens)
    rows.set(key, { ...current, tokens, usd: current.usd + computeTokenCost(usage.tokens, entry) })
  }
  return [...rows.values()].sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1
    if (a.matched && b.matched && a.usd !== b.usd) return b.usd - a.usd
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

export interface SessionUsage {
  readonly sessionID: string
  readonly usages: readonly UsageInput[]
}

export interface FamilyReport {
  /** Family total in USD, matched models only. */
  readonly total: number
  /** Per-model breakdown merged across the whole family. */
  readonly models: readonly ModelUsage[]
  readonly subagents: {
    /** Number of non-root sessions in the family. */
    readonly count: number
    /** Matched-model cost of the non-root sessions. */
    readonly total: number
  }
  /** Number of models without a LiteLLM price. */
  readonly unmatchedModels: number
}

/**
 * Roll up a session family (root plus subagent sessions) into one report.
 * `rootID` only decides which sessions count as "subagents"; every session
 * in the list contributes to `total` and `models`.
 */
export function rollupFamily(sessions: readonly SessionUsage[], rootID: string, lookup: PriceLookupFn): FamilyReport {
  let total = 0
  let subagentCount = 0
  let subagentTotal = 0
  const all: UsageInput[] = []
  for (const session of sessions) {
    let sessionTotal = 0
    for (const usage of session.usages) {
      all.push(usage)
      const entry = lookup(usage.model.providerID, usage.model.id)
      sessionTotal += computeTokenCost(usage.tokens, entry)
    }
    total += sessionTotal
    if (session.sessionID !== rootID) {
      subagentCount++
      subagentTotal += sessionTotal
    }
  }
  const models = aggregateModels(all, lookup)
  return {
    total,
    models,
    subagents: { count: subagentCount, total: subagentTotal },
    unmatchedModels: models.filter((row) => !row.matched).length,
  }
}

/** Project window: last 7 days by session creation time. */
export const PROJECT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Safety cap on sessions scanned for the project total. */
export const PROJECT_SESSION_CAP = 200

export function isInProjectWindow(createdMs: number, nowMs: number, windowMs: number = PROJECT_WINDOW_MS): boolean {
  return Number.isFinite(createdMs) && createdMs >= nowMs - windowMs
}

/**
 * Stop condition for descending (newest-first) session pagination: stop at
 * the first session created before the window, at the session cap, or when
 * the timestamp is unusable.
 */
export function shouldStopProjectPagination(
  createdMs: number | undefined,
  nowMs: number,
  sessionsSeen: number,
  windowMs: number = PROJECT_WINDOW_MS,
  cap: number = PROJECT_SESSION_CAP,
): boolean {
  if (sessionsSeen >= cap) return true
  if (createdMs === undefined || !Number.isFinite(createdMs)) return true
  return createdMs < nowMs - windowMs
}

/** Format USD with fixed decimals, e.g. formatUSD(0.0158, 4) === "$0.0158". */
export function formatUSD(amount: number, decimals: number): string {
  return `$${amount.toFixed(decimals)}`
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "")
}

/** Abbreviate token counts: 999 -> "999", 1234 -> "1.2k", 1.5e6 -> "1.5M". */
export function formatTokens(count: number): string {
  const n = Math.max(0, count)
  if (n < 999.5) return String(Math.round(n))
  if (n < 999_500) return `${trim(n / 1e3)}k`
  if (n < 999_500_000) return `${trim(n / 1e6)}M`
  return `${trim(n / 1e9)}G`
}

/** Human label for a price-cache age in milliseconds. */
export function formatAge(ageMs: number): string {
  const ms = Math.max(0, ageMs)
  if (ms < 60_000) return "just now"
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m old`
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}h old`
  return `${Math.floor(ms / (24 * 60 * 60_000))}d old`
}
