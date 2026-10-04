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

/**
 * First-party provider prefixes whose LiteLLM key carries the vendor's own
 * list price (as opposed to a reseller such as `openrouter/...` or
 * `aihubmix/...`). Used by the suffix fallback to prefer canonical pricing.
 */
const VENDOR_PREFIXES: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "gemini",
  "deepseek",
  "zai",
  "xiaomi_mimo",
  "mistral",
  "cohere",
  "xai",
  "groq",
])

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

/** modelID (final path segment) -> full keys, built once per table and cached. */
const suffixIndexCache = new WeakMap<PriceTable, ReadonlyMap<string, readonly string[]>>()

function suffixIndex(table: PriceTable): ReadonlyMap<string, readonly string[]> {
  const cached = suffixIndexCache.get(table)
  if (cached !== undefined) return cached
  const index = new Map<string, string[]>()
  for (const key of Object.keys(table)) {
    const slash = key.lastIndexOf("/")
    if (slash <= 0 || slash === key.length - 1) continue
    const modelID = key.slice(slash + 1)
    const existing = index.get(modelID)
    if (existing === undefined) index.set(modelID, [key])
    else existing.push(key)
  }
  suffixIndexCache.set(table, index)
  return index
}

/**
 * Last-resort match for models served by generic or coding-plan providers
 * whose upstream vendor is not derivable from the provider id (e.g.
 * `opencode-go/mimo-v2.6-pro` -> `xiaomi_mimo/mimo-v2.6-pro`). Match the model
 * id against the final segment of LiteLLM keys, preferring a known first-party
 * vendor key; otherwise accept a single unambiguous match. Ambiguous
 * non-vendor keys stay unmatched — a price is never guessed.
 */
function suffixMatch(table: PriceTable, modelID: string): PriceEntry | undefined {
  const candidates = suffixIndex(table).get(modelID)
  if (candidates === undefined || candidates.length === 0) return undefined
  for (const key of candidates) {
    const prefix = key.slice(0, key.length - modelID.length - 1)
    if (VENDOR_PREFIXES.has(prefix)) return get(table, key)
  }
  if (candidates.length === 1) {
    const only = candidates[0]
    if (only !== undefined) return get(table, only)
  }
  return undefined
}

/**
 * Deterministic model matching; first hit wins:
 * 1. exact `${providerID}/${modelID}`
 * 2. alias prefixes for the provider, in declared order
 * 3. dash-prefix cascade for coding-plan providers (`zai-coding-plan` -> `zai`)
 * 4. bare `${modelID}` (handles ids that already carry their prefix)
 * 5. suffix fallback (see `suffixMatch`): final-segment match preferring a
 *    first-party vendor key
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

  // Coding-plan and gateway providers keep their upstream vendor as the first
  // dash-separated segments (e.g. "zai-coding-plan" -> "zai/glm-5.3"). Try the
  // remaining, progressively shorter dash prefixes, longest first, before the
  // bare-id fallback. Single-segment provider ids skip this step: their exact
  // form was already tried above.
  const segments = providerID.split("-")
  for (let end = segments.length - 1; end >= 1; end--) {
    const prefix = segments.slice(0, end).join("-")
    const entry = get(table, `${prefix}/${modelID}`)
    if (entry !== undefined) return { matched: true, entry }
  }

  const bare = get(table, modelID)
  if (bare !== undefined) return { matched: true, entry: bare }

  const suffix = suffixMatch(table, modelID)
  if (suffix !== undefined) return { matched: true, entry: suffix }

  return { matched: false }
}
