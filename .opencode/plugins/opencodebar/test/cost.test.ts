import { describe, expect, it } from "vitest"
import type { PriceEntry } from "../src/pricing"
import {
  aggregateModels,
  computeTokenCost,
  formatAge,
  formatTokens,
  formatUSD,
  isInProjectWindow,
  PROJECT_SESSION_CAP,
  PROJECT_WINDOW_MS,
  rollupFamily,
  shouldStopProjectPagination,
  type TokenUsage,
  type UsageInput,
} from "../src/cost"

const DAY_MS = 24 * 60 * 60 * 1000

function entry(partial: Partial<PriceEntry> = {}): PriceEntry {
  return {
    input: 3e-6,
    output: 15e-6,
    cacheRead: 0.3e-6,
    cacheWrite: 3.75e-6,
    known: { input: true, output: true, cacheRead: true, cacheWrite: true },
    litellmKey: "test/model",
    ...partial,
  }
}

function usage(providerID: string, id: string, tokens: Partial<TokenUsage> = {}): UsageInput {
  return {
    model: { providerID, id },
    tokens: {
      input: 1000,
      output: 500,
      reasoning: 200,
      cache: { read: 5000, write: 1000 },
      ...tokens,
      ...(tokens.cache ? { cache: tokens.cache } : {}),
    },
  }
}

// 1000*3e-6 + 500*15e-6 + 5000*0.3e-6 + 1000*3.75e-6 = 0.01575
const FULL_COST = 0.01575

describe("computeTokenCost", () => {
  it("applies the four-tier per-token formula", () => {
    const tokens: TokenUsage = { input: 1000, output: 500, reasoning: 200, cache: { read: 5000, write: 1000 } }
    expect(computeTokenCost(tokens, entry())).toBeCloseTo(FULL_COST, 10)
  })

  it("does not bill reasoning tokens on top of output by default", () => {
    const withReasoning: TokenUsage = { input: 1000, output: 500, reasoning: 9000, cache: { read: 0, write: 0 } }
    const withoutReasoning: TokenUsage = { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(computeTokenCost(withReasoning, entry())).toBe(computeTokenCost(withoutReasoning, entry()))
  })

  it("bills reasoning tokens as output when explicitly requested", () => {
    const tokens: TokenUsage = { input: 0, output: 0, reasoning: 1000, cache: { read: 0, write: 0 } }
    expect(computeTokenCost(tokens, entry(), { includeReasoning: true })).toBeCloseTo(1000 * 15e-6, 10)
  })

  it("treats unknown price tiers as zero", () => {
    const partial = entry({
      cacheRead: 0,
      cacheWrite: 0,
      known: { input: true, output: true, cacheRead: false, cacheWrite: false },
    })
    const tokens: TokenUsage = { input: 1000, output: 500, reasoning: 0, cache: { read: 5000, write: 1000 } }
    expect(computeTokenCost(tokens, partial)).toBeCloseTo(1000 * 3e-6 + 500 * 15e-6, 10)
  })

  it("returns zero for a missing price entry", () => {
    const tokens: TokenUsage = { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(computeTokenCost(tokens, undefined)).toBe(0)
  })
})

describe("aggregateModels", () => {
  it("merges usage per model and sorts by cost descending with unmatched last", () => {
    const cheap = entry({ input: 1e-6, output: 1e-6, cacheRead: 0, cacheWrite: 0, litellmKey: "test/cheap" })
    const pricey = entry({ input: 10e-6, output: 20e-6, cacheRead: 0, cacheWrite: 0, litellmKey: "test/pricey" })
    const lookup = (providerID: string, modelID: string): PriceEntry | undefined => {
      if (modelID === "pricey") return pricey
      if (modelID === "cheap") return cheap
      return undefined
    }

    const rows = aggregateModels(
      [
        usage("test", "pricey"),
        usage("test", "cheap"),
        usage("test", "pricey", { input: 100, output: 50, cache: { read: 0, write: 0 } }),
        usage("test", "mystery", { input: 42, output: 0, cache: { read: 0, write: 0 } }),
      ],
      lookup,
    )

    expect(rows).toHaveLength(3)
    expect(rows[0]?.modelID).toBe("pricey")
    expect(rows[0]?.tokens.input).toBe(1100)
    expect(rows[0]?.tokens.output).toBe(550)
    expect(rows[0]?.matched).toBe(true)
    expect(rows[1]?.modelID).toBe("cheap")
    expect(rows[1]?.matched).toBe(true)
    expect(rows[2]?.modelID).toBe("mystery")
    expect(rows[2]?.matched).toBe(false)
    expect(rows[2]?.usd).toBe(0)
    expect(rows[2]?.tokens.input).toBe(42)
  })

  it("keys rows by provider and model id", () => {
    const rows = aggregateModels([usage("anthropic", "claude-sonnet-4-5")], () => entry())
    expect(rows[0]?.key).toBe("anthropic/claude-sonnet-4-5")
  })
})

describe("rollupFamily", () => {
  const lookup = (providerID: string, modelID: string): PriceEntry | undefined =>
    modelID === "claude-sonnet-4-5" || modelID === "gpt-5-mini" ? entry() : undefined

  it("rolls the root session and subagents into one report", () => {
    const report = rollupFamily(
      [
        {
          sessionID: "root",
          usages: [
            usage("anthropic", "claude-sonnet-4-5"),
            usage("weird", "unknown-model", { input: 10, output: 10, cache: { read: 0, write: 0 } }),
          ],
        },
        { sessionID: "sub-1", usages: [usage("openai", "gpt-5-mini")] },
        { sessionID: "sub-2", usages: [usage("weird", "unknown-model", { input: 5, output: 0, cache: { read: 0, write: 0 } })] },
      ],
      "root",
      lookup,
    )

    // Two matched messages at FULL_COST each; the unknown model contributes nothing.
    expect(report.total).toBeCloseTo(FULL_COST * 2, 10)
    expect(report.models).toHaveLength(3)
    expect(report.unmatchedModels).toBe(1)
    expect(report.subagents.count).toBe(2)
    expect(report.subagents.total).toBeCloseTo(FULL_COST, 10)
  })

  it("hides the subagent rollup for a single-session family", () => {
    const report = rollupFamily([{ sessionID: "root", usages: [usage("anthropic", "claude-sonnet-4-5")] }], "root", lookup)
    expect(report.subagents.count).toBe(0)
    expect(report.subagents.total).toBe(0)
    expect(report.total).toBeCloseTo(FULL_COST, 10)
  })

  it("ignores usages from sessions outside the family list and unknown roots", () => {
    const report = rollupFamily(
      [
        { sessionID: "sub-only", usages: [usage("anthropic", "claude-sonnet-4-5")] },
      ],
      "missing-root",
      lookup,
    )
    expect(report.total).toBeCloseTo(FULL_COST, 10)
    expect(report.subagents.count).toBe(1)
    expect(report.subagents.total).toBeCloseTo(FULL_COST, 10)
  })
})

describe("project window", () => {
  const now = Date.UTC(2026, 9, 4)

  it("defines a 7-day window", () => {
    expect(PROJECT_WINDOW_MS).toBe(7 * DAY_MS)
    expect(PROJECT_SESSION_CAP).toBe(200)
  })

  it("includes sessions created at or after the cutoff", () => {
    expect(isInProjectWindow(now - PROJECT_WINDOW_MS, now)).toBe(true)
    expect(isInProjectWindow(now, now)).toBe(true)
    expect(isInProjectWindow(now - PROJECT_WINDOW_MS - 1, now)).toBe(false)
  })

  it("stops descending pagination at the first session older than the window", () => {
    expect(shouldStopProjectPagination(now - 6 * DAY_MS, now, 10)).toBe(false)
    expect(shouldStopProjectPagination(now - 8 * DAY_MS, now, 10)).toBe(true)
  })

  it("stops pagination at the session cap", () => {
    expect(shouldStopProjectPagination(now, now, PROJECT_SESSION_CAP)).toBe(true)
    expect(shouldStopProjectPagination(now, now, PROJECT_SESSION_CAP - 1)).toBe(false)
  })

  it("stops pagination defensively on missing timestamps", () => {
    expect(shouldStopProjectPagination(undefined, now, 0)).toBe(true)
    expect(shouldStopProjectPagination(Number.NaN, now, 0)).toBe(true)
  })
})

describe("formatting", () => {
  it("formats USD with fixed decimals", () => {
    expect(formatUSD(0, 4)).toBe("$0.0000")
    expect(formatUSD(0.5, 4)).toBe("$0.5000")
    expect(formatUSD(FULL_COST, 4)).toBe("$0.0158")
    expect(formatUSD(12.345, 2)).toBe("$12.35")
    expect(formatUSD(0, 2)).toBe("$0.00")
  })

  it("abbreviates token counts", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(1000)).toBe("1k")
    expect(formatTokens(1234)).toBe("1.2k")
    expect(formatTokens(999_999)).toBe("1M")
    expect(formatTokens(1_500_000)).toBe("1.5M")
    expect(formatTokens(1_230_000_000)).toBe("1.2G")
  })

  it("formats price cache age", () => {
    expect(formatAge(0)).toBe("just now")
    expect(formatAge(59_000)).toBe("just now")
    expect(formatAge(60_000)).toBe("1m old")
    expect(formatAge(90 * 60_000)).toBe("1h old")
    expect(formatAge(25 * 60 * 60_000)).toBe("1d old")
    expect(formatAge(3 * DAY_MS)).toBe("3d old")
  })
})
