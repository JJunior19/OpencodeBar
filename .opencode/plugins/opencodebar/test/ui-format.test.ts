import { describe, expect, it } from "vitest"
import { billedOutput, fitLabel, panelRow, sectionHeader, shareBar, tokenDetail } from "../src/format"

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

describe("shareBar", () => {
  it("scales proportionally with a minimum of one cell", () => {
    expect(shareBar(10, 10, 2)).toBe("▇▇▇▇▇")
    expect(shareBar(5, 10, 2)).toBe("▇▇▇")
    expect(shareBar(1, 10, 2)).toBe("▇")
  })

  it("returns empty without a meaningful comparison", () => {
    expect(shareBar(10, 10, 1)).toBe("")
    expect(shareBar(0, 0, 2)).toBe("")
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
