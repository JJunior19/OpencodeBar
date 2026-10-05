import { describe, expect, it } from "vitest"
import {
  DETENT,
  NAME_MAX,
  PANEL_WIDTH,
  SHARE_ZONE_WIDTH,
  VALUE_WIDTH,
  billedOutput,
  fitLabel,
  formatUSDAdaptive,
  heartbeatFooter,
  panelRow,
  sectionHeader,
  shareBar,
  tokenDetail,
  truncateWithEllipsis,
} from "../src/format"

describe("fitLabel", () => {
  it("pads short labels to the target width", () => {
    expect(fitLabel("glm-5.3", 10)).toBe("glm-5.3   ")
  })

  it("truncates long labels with an ellipsis", () => {
    expect(fitLabel("claude-sonnet-4-5", 10)).toBe("claude-so…")
    expect(fitLabel("claude-sonnet-4-5", 10)).toHaveLength(10)
  })
})

describe("panelRow", () => {
  it("aligns values into a fixed right column", () => {
    const row = panelRow("Session", "$1.50", 8)
    expect(row).toBe("Session      $1.50")
    expect(row.length).toBe(8 + 10)
  })
})

describe("sectionHeader", () => {
  it("frames the title with dashes at the exact width", () => {
    const header = sectionHeader("Cost · API est.", 30)
    expect(header).toHaveLength(30)
    expect(header.startsWith("── Cost · API est. ")).toBe(true)
    expect(header.endsWith("─")).toBe(true)
  })
})

describe("shareBar (share of family total)", () => {
  it("draws a 7-cell zone: bar padded to 3, gap, right-aligned percent", () => {
    expect(shareBar(4.2, 10, 2)).toBe("▇   42%")
    expect(shareBar(5, 10, 2)).toBe("▇▇  50%")
    expect(shareBar(0.7, 10, 2)).toBe("▇    7%")
  })

  it("keeps exactly 7 cells even at a rounded 100 percent", () => {
    expect(shareBar(10, 10, 2)).toBe("▇▇▇100%")
    expect(shareBar(10, 10, 2)).toHaveLength(SHARE_ZONE_WIDTH)
  })

  it("enforces a minimum of one bar cell when drawn", () => {
    expect(shareBar(0.01, 10, 2)).toBe("▇    0%")
  })

  it("never exceeds the 7-cell zone across the share range", () => {
    for (const share of [0.001, 0.07, 0.25, 0.42, 0.5, 0.75, 0.99, 1]) {
      expect(shareBar(share * 10, 10, 2)).toHaveLength(SHARE_ZONE_WIDTH)
    }
  })

  it("returns empty without a meaningful comparison", () => {
    expect(shareBar(10, 10, 1)).toBe("")
    expect(shareBar(0, 0, 2)).toBe("")
  })
})

describe("formatUSDAdaptive", () => {
  it("uses two decimals from $100", () => {
    expect(formatUSDAdaptive(123.456)).toBe("$123.46")
    expect(formatUSDAdaptive(100)).toBe("$100.00")
  })

  it("uses three decimals from $1", () => {
    expect(formatUSDAdaptive(12.3456)).toBe("$12.346")
    expect(formatUSDAdaptive(1)).toBe("$1.000")
  })

  it("keeps four decimals below $1", () => {
    expect(formatUSDAdaptive(0.98765)).toBe("$0.9877")
    expect(formatUSDAdaptive(0)).toBe("$0.0000")
  })
})

describe("truncateWithEllipsis", () => {
  it("returns lines within the width unchanged", () => {
    expect(truncateWithEllipsis("! ctx: session list failed", PANEL_WIDTH)).toBe("! ctx: session list failed")
  })

  it("truncates overflowing lines to the width with an ellipsis", () => {
    const line = truncateWithEllipsis(`! ${"x".repeat(50)}`, PANEL_WIDTH)
    expect(line).toHaveLength(PANEL_WIDTH)
    expect(line.endsWith("…")).toBe(true)
    expect(truncateWithEllipsis("! boom", 1)).toBe("…")
  })
})

describe("heartbeatFooter", () => {
  it("appends the revision heartbeat to a fitting footer", () => {
    expect(heartbeatFooter("38 sessions · prices: 2m old", 17)).toBe("38 sessions · prices: 2m old · r17")
  })

  it("trims the body, never the heartbeat, at the width limit", () => {
    const line = heartbeatFooter("200 sessions · prices: just now", 1234)
    expect(line).toHaveLength(PANEL_WIDTH)
    expect(line.endsWith(" · r1234")).toBe(true)
  })
})

describe("layout budget", () => {
  it("keeps the per-model row inside the 34-column budget", () => {
    expect(DETENT + NAME_MAX + SHARE_ZONE_WIDTH + VALUE_WIDTH).toBeLessThanOrEqual(PANEL_WIDTH)
  })
})

describe("token helpers", () => {
  it("bills reasoning as output", () => {
    expect(billedOutput({ input: 0, output: 100, reasoning: 40, cache: { read: 0, write: 0 } })).toBe(140)
  })

  it("renders an icon token detail line", () => {
    const line = tokenDetail({ input: 1_200_000, output: 340_000, reasoning: 0, cache: { read: 8_100_000, write: 10_000 } })
    expect(line).toBe("↓ 1.2M · ↑ 340k · ↺ 8.1M")
  })
})
