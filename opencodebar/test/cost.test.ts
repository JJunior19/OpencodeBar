import { describe, expect, it } from "vitest"
import type { PriceEntry } from "../src/pricing"
import {
  aggregateModels,
  computeTokenCost,
  computeTokenSavings,
  formatAge,
  formatTokens,
  formatUSD,
  isInProjectWindow,
  PROJECT_SESSION_CAP,
  PROJECT_WINDOW_MS,
  resolveProjectDirectories,
  rollupFamily,
  shouldStopProjectPagination,
  withSubagentNames,
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

// 1000*3e-6 + (500+200)*15e-6 + 5000*0.3e-6 + 1000*3.75e-6 = 0.01875 (reasoning billed as output)
const FULL_COST = 0.01875

describe("resolveProjectDirectories", () => {
  it("unions the server-reported directories with the session directory", () => {
    expect(resolveProjectDirectories(["/repo", "/repo-wt-a"], "/repo-wt-b")).toEqual([
      "/repo",
      "/repo-wt-a",
      "/repo-wt-b",
    ])
  })

  it("dedupes, keeping first occurrence order", () => {
    expect(resolveProjectDirectories(["/repo", "/wt", "/repo"], "/wt")).toEqual(["/repo", "/wt"])
  })

  it("degrades to the session directory when the listing is empty or failed", () => {
    expect(resolveProjectDirectories([], "/repo")).toEqual(["/repo"])
  })

  it("drops empty strings so a malformed entry never becomes a scan target", () => {
    expect(resolveProjectDirectories(["", "/wt"], "/repo")).toEqual(["/wt", "/repo"])
  })
})

describe("computeTokenCost", () => {
  it("applies the four-tier per-token formula", () => {
    const tokens: TokenUsage = { input: 1000, output: 500, reasoning: 200, cache: { read: 5000, write: 1000 } }
    expect(computeTokenCost(tokens, entry())).toBeCloseTo(FULL_COST, 10)
  })

  it("bills reasoning tokens at the output rate by default", () => {
    const withReasoning: TokenUsage = { input: 1000, output: 500, reasoning: 9000, cache: { read: 0, write: 0 } }
    const withoutReasoning: TokenUsage = { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(computeTokenCost(withReasoning, entry())).toBeCloseTo(
      computeTokenCost(withoutReasoning, entry()) + 9000 * 15e-6,
      10,
    )
  })

  it("excludes reasoning tokens when explicitly requested", () => {
    const tokens: TokenUsage = { input: 1000, output: 500, reasoning: 200, cache: { read: 5000, write: 1000 } }
    // 1000*3e-6 + 500*15e-6 + 5000*0.3e-6 + 1000*3.75e-6 = 0.01575
    expect(computeTokenCost(tokens, entry(), { includeReasoning: false })).toBeCloseTo(0.01575, 10)
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

describe("computeTokenSavings", () => {
  const CACHED: TokenUsage = { input: 1000, output: 500, reasoning: 0, cache: { read: 5000, write: 1000 } }

  it("returns zero for a missing price entry", () => {
    expect(computeTokenSavings(CACHED, undefined)).toBe(0)
  })

  it("counts the discount of cached tokens against the input price", () => {
    // balanced tiers: 5000*(3e-6-0.3e-6) + 1000*(3e-6-0.3e-6) = 0.0162
    const balanced = entry({ cacheWrite: 0.3e-6 })
    expect(computeTokenSavings(CACHED, balanced)).toBeCloseTo(0.0162, 10)
  })

  it("clamps a component whose cache price exceeds the input price to zero", () => {
    // default entry: cacheWrite 3.75e-6 > input 3e-6 -> write saves nothing;
    // read still saves 5000*(3e-6-0.3e-6) = 0.0135.
    expect(computeTokenSavings(CACHED, entry())).toBeCloseTo(0.0135, 10)
  })

  it("treats unknown cache tiers as free cache (full input-price saving)", () => {
    const partial = entry({
      cacheRead: 0,
      cacheWrite: 0,
      known: { input: true, output: true, cacheRead: false, cacheWrite: false },
    })
    expect(computeTokenSavings(CACHED, partial)).toBeCloseTo(6000 * 3e-6, 10)
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

  it("aggregates family-wide token totals across root and subagents", () => {
    const report = rollupFamily(
      [
        {
          sessionID: "root",
          usages: [usage("anthropic", "claude-sonnet-4-5", { input: 100, output: 50, reasoning: 20, cache: { read: 500, write: 60 } })],
        },
        {
          sessionID: "sub-1",
          usages: [usage("openai", "gpt-5-mini", { input: 30, output: 15, reasoning: 5, cache: { read: 90, write: 0 } })],
        },
      ],
      "root",
      lookup,
    )
    expect(report.tokens).toEqual({
      input: 130,
      output: 65,
      reasoning: 25,
      cache: { read: 590, write: 60 },
    })
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

  it("accumulates cache savings across root and subagents", () => {
    const report = rollupFamily(
      [
        { sessionID: "root", usages: [usage("anthropic", "claude-sonnet-4-5")] },
        { sessionID: "sub-1", usages: [usage("openai", "gpt-5-mini")] },
        { sessionID: "sub-2", usages: [usage("weird", "unknown-model", { input: 5, output: 0, cache: { read: 0, write: 0 } })] },
      ],
      "root",
      lookup,
    )
    // Two matched usages save 0.0135 each (reads discounted, write tier
    // clamped); the unknown model never contributes savings.
    expect(report.cacheSaved).toBeCloseTo(2 * 0.0135, 10)
  })

  it("breaks subagent cost down per session, sorted by cost descending", () => {
    const report = rollupFamily(
      [
        { sessionID: "root", usages: [usage("anthropic", "claude-sonnet-4-5")] },
        {
          sessionID: "sub-light",
          usages: [usage("openai", "gpt-5-mini", { input: 100, output: 50, cache: { read: 0, write: 0 } })],
        },
        { sessionID: "sub-heavy", usages: [usage("openai", "gpt-5-mini"), usage("anthropic", "claude-sonnet-4-5")] },
        { sessionID: "sub-idle", usages: [] },
      ],
      "root",
      lookup,
    )
    expect(report.subagents.items.map((item) => item.sessionID)).toEqual(["sub-heavy", "sub-light", "sub-idle"])
    expect(report.subagents.items).toHaveLength(report.subagents.count)
    const sum = report.subagents.items.reduce((acc, item) => acc + item.usd, 0)
    expect(sum).toBeCloseTo(report.subagents.total, 10)
    expect(report.subagents.items[0]?.usd).toBeCloseTo(FULL_COST * 2, 10)
  })
})

describe("withSubagentNames", () => {
  const lookup = (providerID: string, modelID: string): PriceEntry | undefined =>
    modelID === "claude-sonnet-4-5" || modelID === "gpt-5-mini" ? entry() : undefined

  it("resolves names onto items without changing order or totals", () => {
    const base = rollupFamily(
      [
        { sessionID: "root", usages: [usage("anthropic", "claude-sonnet-4-5")] },
        { sessionID: "sub-1", usages: [usage("openai", "gpt-5-mini")] },
      ],
      "root",
      lookup,
    )
    const named = withSubagentNames(base, (id) => (id === "sub-1" ? "explore workers" : ""))
    expect(named.subagents.items).toHaveLength(1)
    expect(named.subagents.items[0]?.name).toBe("explore workers")
    expect(named.subagents.items[0]?.usd).toBeCloseTo(base.subagents.total, 10)
    expect(named.total).toBeCloseTo(base.total, 10)
    expect(named.subagents.count).toBe(base.subagents.count)
    // Pure call: the source report is not mutated.
    expect(base.subagents.items[0]).not.toHaveProperty("name")
  })

  it("allows empty names for sessions without a title", () => {
    const base = rollupFamily(
      [
        { sessionID: "root", usages: [] },
        { sessionID: "sub-1", usages: [usage("openai", "gpt-5-mini")] },
      ],
      "root",
      lookup,
    )
    const named = withSubagentNames(base, () => "")
    expect(named.subagents.items[0]?.name).toBe("")
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
    expect(formatUSD(FULL_COST, 4)).toBe("$0.0187")
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
