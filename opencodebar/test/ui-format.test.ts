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
  labelWidthToEdge,
  panelRow,
  sectionHeader,
  sectionHeaderParts,
  shareBar,
  sparklineBlocks,
  todayLine,
  tokenDetail,
  truncateWithEllipsis,
  valueEdge,
} from "../src/format"

describe("fitLabel", () => {
  it("pads short labels to the target width", () => {
    expect(fitLabel("glm-5.3", 10)).toBe("glm-5.3   ")
  })

  it("passes an exact-width label through unchanged", () => {
    expect(fitLabel("Project · 7d", 12)).toBe("Project · 7d")
    expect(fitLabel("exact", 5)).toBe("exact")
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

describe("valueEdge (single shared value column)", () => {
  it("matches the per-model row width: indent + name + gap + share zone + value", () => {
    expect(valueEdge(13)).toBe(DETENT + 13 + 1 + SHARE_ZONE_WIDTH + VALUE_WIDTH)
    expect(valueEdge(NAME_MAX)).toBe(34)
    expect(valueEdge(8)).toBe(28)
  })

  it("right-aligns every row type on the same edge", () => {
    const edge = valueEdge(13)
    const session = panelRow("Session", "$0.3560", labelWidthToEdge(edge, 0))
    const project = panelRow("Project · 7d", "$26.41", labelWidthToEdge(edge, 0))
    const subagent = " ".repeat(DETENT + 1) + panelRow("explore-wor", "$0.21", labelWidthToEdge(edge, DETENT + 1))
    const model =
      " ".repeat(DETENT) + fitLabel("glm-5.3", 13) + " " + shareBar(9.876, 12, 2).padEnd(SHARE_ZONE_WIDTH) + "$9.876".padStart(VALUE_WIDTH)
    for (const row of [session, project, subagent, model]) {
      expect(row.length).toBe(edge)
    }
    expect(session.endsWith("$0.3560")).toBe(true)
    expect(project.endsWith("$26.41")).toBe(true)
    expect(subagent.endsWith("$0.21")).toBe(true)
    expect(model.endsWith("$9.876")).toBe(true)
  })

  it("never returns a label width below one cell", () => {
    expect(labelWidthToEdge(5, 0)).toBe(1)
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

  it("draws a full bar for the common single-model family", () => {
    expect(shareBar(10, 10, 1)).toBe("▇▇▇100%")
    expect(shareBar(10, 10, 1)).toHaveLength(SHARE_ZONE_WIDTH)
  })

  it("returns empty only when there is no positive total to share", () => {
    expect(shareBar(0, 0, 1)).toBe("")
    expect(shareBar(0, 0, 2)).toBe("")
    expect(shareBar(3, 0, 2)).toBe("")
  })
})

describe("sparklineBlocks (weekly timeline)", () => {
  it("renders nothing for empty input", () => {
    expect(sparklineBlocks([])).toBe("")
  })

  it("renders one space per day when every value is zero", () => {
    expect(sparklineBlocks([0, 0, 0, 0, 0, 0, 0])).toBe("       ")
  })

  it("maps a monotonic ramp through the sqrt curve", () => {
    // level = round(sqrt(v/max) * 6) for v = 1..7 (max 7):
    //   [2.27, 3.21, 3.93, 4.54, 5.07, 5.55, 6] -> ramp[2,3,4,5,5,6,6]
    expect(sparklineBlocks([1, 2, 3, 4, 5, 6, 7])).toBe("▃▄▅▆▆▇▇")
  })

  it("renders zero days as spaces around a single spike", () => {
    expect(sparklineBlocks([0, 0, 9, 0, 0, 0, 0])).toBe("  ▇    ")
  })

  it("keeps the max day on the top block and lifts a half-max day to ramp[4]", () => {
    // half-max: round(sqrt(0.5) * 6) = round(4.24) = 4 -> ▅ (linear was ▄)
    expect(sparklineBlocks([8, 0, 4, 0, 8, 0, 0])).toBe("▇ ▅ ▇  ")
    expect(sparklineBlocks([8, 0, 4, 0, 8, 0, 0])).toHaveLength(7)
  })

  it("draws a quarter-max day above the linear level", () => {
    // quarter-max: round(sqrt(0.25) * 6) = round(3) = 3 -> ▄ (linear: ▃)
    expect(sparklineBlocks([4, 1, 4])).toBe("▇▄▇")
  })
})

describe("todayLine (project today row + savings)", () => {
  it("renders today's spend and positive savings", () => {
    // formatUSDAdaptive: $4.196 (4 decimals <$1), $12.400 (3 decimals >= $1)
    expect(todayLine(4.196, 12.4)).toBe(" Today $4.196 · saved $12.400")
  })

  it("omits the savings part when nothing was saved", () => {
    expect(todayLine(0.5123, 0)).toBe(" Today $0.5123")
  })

  it("stays inside the 34-column budget at extreme values", () => {
    // Widest adaptive renderings: today "$12345.67" (9 cells, >= $10000) and
    // saved "$123456.78" (10 cells): 1+5+1+9+3+5+1+10 = 35 -> trimmed.
    const line = todayLine(12345.67, 123456.78)
    expect(line.length).toBeLessThanOrEqual(PANEL_WIDTH)
  })
})

describe("sectionHeaderParts (brand header segments)", () => {
  it("splits the brand so the pieces reassemble the full header line", () => {
    for (const width of [22, 26, 34]) {
      const [lead, brand, tail] = sectionHeaderParts(width)
      expect(brand).toBe("OpencodeBar")
      expect(lead + brand + tail).toBe(sectionHeader("OpencodeBar · API est.", width))
    }
  })

  it("keeps the brand header inside the panel budget at its natural width", () => {
    const natural = sectionHeaderParts(0).join("")
    expect(natural).toHaveLength(26)
    expect(natural.length).toBeLessThanOrEqual(PANEL_WIDTH)
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
