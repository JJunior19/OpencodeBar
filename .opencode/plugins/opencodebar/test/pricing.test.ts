import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { PROVIDER_ALIASES, lookupPrice, parseLiteLLMPrices } from "../src/pricing"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/model_prices.sample.json", import.meta.url), "utf8"),
)

describe("parseLiteLLMPrices", () => {
  it("trims entries to per-token cost fields with source key", () => {
    const table = parseLiteLLMPrices(fixture)
    const entry = table["anthropic/claude-sonnet-4-5"]
    expect(entry).toBeDefined()
    expect(entry?.input).toBe(0.000003)
    expect(entry?.output).toBe(0.000015)
    expect(entry?.cacheRead).toBe(0.0000003)
    expect(entry?.cacheWrite).toBe(0.00000375)
    expect(entry?.known).toEqual({
      input: true,
      output: true,
      cacheRead: true,
      cacheWrite: true,
    })
    expect(entry?.litellmKey).toBe("anthropic/claude-sonnet-4-5")
  })

  it("treats missing cache cost fields as zero and unknown", () => {
    const table = parseLiteLLMPrices(fixture)
    const entry = table["example/model-without-cache-costs"]
    expect(entry).toBeDefined()
    expect(entry?.input).toBe(0.000001)
    expect(entry?.output).toBe(0.000002)
    expect(entry?.cacheRead).toBe(0)
    expect(entry?.cacheWrite).toBe(0)
    expect(entry?.known).toEqual({
      input: true,
      output: true,
      cacheRead: false,
      cacheWrite: false,
    })
  })

  it("skips entries without any per-token cost fields", () => {
    const table = parseLiteLLMPrices(fixture)
    expect(table["example/model-without-costs"]).toBeUndefined()
  })

  it("returns an empty table for non-object input", () => {
    expect(parseLiteLLMPrices(null)).toEqual({})
    expect(parseLiteLLMPrices("nope")).toEqual({})
    expect(parseLiteLLMPrices([])).toEqual({})
  })

  it("ignores non-numeric cost values inside an entry", () => {
    const table = parseLiteLLMPrices({
      "we/model": {
        input_cost_per_token: "free",
        output_cost_per_token: 0.000002,
      },
    })
    const entry = table["we/model"]
    expect(entry?.input).toBe(0)
    expect(entry?.known.input).toBe(false)
    expect(entry?.output).toBe(0.000002)
  })
})

describe("lookupPrice", () => {
  it("matches provider-prefixed model id exactly first", () => {
    const table = parseLiteLLMPrices(fixture)
    const result = lookupPrice(table, "anthropic", "claude-sonnet-4-5")
    expect(result.matched).toBe(true)
    expect(result.entry?.litellmKey).toBe("anthropic/claude-sonnet-4-5")
  })

  it("tries google alias prefixes when the exact key misses", () => {
    const table = parseLiteLLMPrices(fixture)
    // No google/gemini-2.5-pro key exists; alias order for the google
    // provider is ["gemini", "google"], so gemini/gemini-2.5-pro must match.
    expect(PROVIDER_ALIASES.google).toEqual(["gemini", "google"])
    const result = lookupPrice(table, "google", "gemini-2.5-pro")
    expect(result.matched).toBe(true)
    expect(result.entry?.litellmKey).toBe("gemini/gemini-2.5-pro")
  })

  it("prefers the exact provider-prefixed key over aliases", () => {
    const table = parseLiteLLMPrices(fixture)
    // Both gemini/ and google/ keys exist for this model; the exact
    // google/gemini-2.5-flash key wins over the gemini alias.
    const result = lookupPrice(table, "google", "gemini-2.5-flash")
    expect(result.matched).toBe(true)
    expect(result.entry?.litellmKey).toBe("google/gemini-2.5-flash")
  })

  it("falls back to the provider's own prefix via aliases", () => {
    const table = parseLiteLLMPrices(fixture)
    const result = lookupPrice(table, "azure", "gpt-4o")
    expect(result.matched).toBe(true)
    expect(result.entry?.litellmKey).toBe("azure/gpt-4o")
  })

  it("falls back to the bare model id when prefixes miss", () => {
    const table = parseLiteLLMPrices(fixture)
    const result = lookupPrice(table, "custom-provider", "bare-model-x")
    expect(result.matched).toBe(true)
    expect(result.entry?.litellmKey).toBe("bare-model-x")
  })

  it("returns unmatched for an unknown model without guessing", () => {
    const table = parseLiteLLMPrices(fixture)
    const result = lookupPrice(table, "anthropic", "claude-unknown-99")
    expect(result.matched).toBe(false)
    expect(result.entry).toBeUndefined()
  })

  it("never partially matches model ids", () => {
    const table = parseLiteLLMPrices(fixture)
    // "claude-sonnet-4-5-20250929" is not a key in the fixture; a substring
    // of it must not match "anthropic/claude-sonnet-4-5".
    const result = lookupPrice(table, "anthropic", "claude-sonnet-4-5-20250929")
    expect(result.matched).toBe(false)
  })
})

describe("provider dash-prefix cascade", () => {
  const table = parseLiteLLMPrices({
    "zai/glm-5.3": {
      input_cost_per_token: 0.0000014,
      output_cost_per_token: 0.0000044,
      cache_read_input_token_cost: 0.00000026,
    },
    "zai/glm-4.5": {
      input_cost_per_token: 0.0000007,
      output_cost_per_token: 0.0000021,
    },
    "glm-4.5": {
      input_cost_per_token: 0.0000005,
      output_cost_per_token: 0.000001,
    },
    "a-b/m": {
      input_cost_per_token: 0.0000009,
      output_cost_per_token: 0.0000018,
    },
    "a/m": {
      input_cost_per_token: 0.0000001,
      output_cost_per_token: 0.0000002,
    },
  })

  it("resolves coding-plan providers to their upstream vendor prefix", () => {
    const result = lookupPrice(table, "zai-coding-plan", "glm-5.3")
    expect(result.matched).toBe(true)
    expect(result.entry?.litellmKey).toBe("zai/glm-5.3")
  })

  it("tries the longest dash prefix first", () => {
    const result = lookupPrice(table, "a-b-c", "m")
    expect(result.matched).toBe(true)
    expect(result.entry?.litellmKey).toBe("a-b/m")
  })

  it("prefers a prefixed entry over an identical bare model id", () => {
    const result = lookupPrice(table, "zai-proxy", "glm-4.5")
    expect(result.matched).toBe(true)
    expect(result.entry?.litellmKey).toBe("zai/glm-4.5")
  })

  it("stays unmatched when no prefix or bare entry exists", () => {
    const result = lookupPrice(table, "github-copilot", "claude-x")
    expect(result.matched).toBe(false)
  })
})
