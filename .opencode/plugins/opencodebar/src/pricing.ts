/**
 * LiteLLM price table: parsing, trimming, and deterministic model matching.
 *
 * Pure, dependency-free module. The single source of truth for prices is
 * https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 * where every cost field is USD per single token.
 */

/** Per-token prices in USD. Missing LiteLLM fields are kept as 0 and flagged in `known`. */
export interface PriceEntry {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly known: PriceKnown
  /** Key of the matched entry in the LiteLLM JSON (kept for display). */
  readonly litellmKey: string
}

export interface PriceKnown {
  readonly input: boolean
  readonly output: boolean
  readonly cacheRead: boolean
  readonly cacheWrite: boolean
}

/** Trimmed price table keyed by LiteLLM model key. JSON-serializable for durable storage. */
export type PriceTable = Readonly<Record<string, PriceEntry>>

/**
 * OpenCode provider ID -> LiteLLM key prefixes to try, in order, when the
 * exact `${providerID}/${modelID}` key misses. Extend as new providers need
 * mapping; unmatched models are reported, never guessed.
 */
export const PROVIDER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  google: ["gemini", "google"],
  azure: ["azure"],
}

const COST_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
] as const

function readCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Trims the LiteLLM pricing JSON to the four per-token cost fields. Entries
 * without at least one numeric cost field (metadata, context-window-only
 * rows) are dropped so a bare-id match can never resolve to a price-less
 * entry.
 */
export function parseLiteLLMPrices(json: unknown): PriceTable {
  if (!isRecord(json)) return {}
  const table: Record<string, PriceEntry> = {}
  for (const [key, raw] of Object.entries(json)) {
    if (!isRecord(raw)) continue
    const input = readCost(raw.input_cost_per_token)
    const output = readCost(raw.output_cost_per_token)
    const cacheRead = readCost(raw.cache_read_input_token_cost)
    const cacheWrite = readCost(raw.cache_creation_input_token_cost)
    if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
      continue
    }
    table[key] = {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: cacheRead ?? 0,
      cacheWrite: cacheWrite ?? 0,
      known: {
        input: input !== undefined,
        output: output !== undefined,
        cacheRead: cacheRead !== undefined,
        cacheWrite: cacheWrite !== undefined,
      },
      litellmKey: key,
    }
  }
  return table
}

export interface PriceLookup {
  readonly matched: boolean
  readonly entry?: PriceEntry
}

function get(table: PriceTable, key: string): PriceEntry | undefined {
  const entry = table[key]
  return entry === undefined || typeof entry.litellmKey !== "string" ? undefined : entry
}

/**
 * Deterministic model matching; first hit wins:
 * 1. exact `${providerID}/${modelID}`
 * 2. alias prefixes for the provider, in declared order
 * 3. bare `${modelID}` (handles ids that already carry their prefix)
 *
 * `variant` is deliberately ignored. No fuzzy or partial matching: an
 * unknown model must surface as "no price", never a guessed price.
 */
export function lookupPrice(table: PriceTable, providerID: string, modelID: string): PriceLookup {
  const prefixed = get(table, `${providerID}/${modelID}`)
  if (prefixed !== undefined) return { matched: true, entry: prefixed }

  const aliases = PROVIDER_ALIASES[providerID]
  if (aliases !== undefined) {
    for (const prefix of aliases) {
      const entry = get(table, `${prefix}/${modelID}`)
      if (entry !== undefined) return { matched: true, entry }
    }
  }

  const bare = get(table, modelID)
  if (bare !== undefined) return { matched: true, entry: bare }

  return { matched: false }
}
