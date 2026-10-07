/**
 * Pure string builders for the sidebar cost panel.
 *
 * JSX-free on purpose: vitest can import this module directly, while the
 * component file (./ui) needs OpenTUI's preserve-mode JSX transform.
 */
import { formatTokens, formatUSD, type TokenUsage } from "./cost"

/** Hard sidebar width budget: no rendered row may exceed this. */
export const PANEL_WIDTH = 34
export const VALUE_WIDTH = 10
/** Share zone: 3 bar cells + 1 gap + 3 percent cells (7 total). */
export const SHARE_ZONE_WIDTH = 7
const SHARE_BAR_CELLS = 3
export const NAME_MIN = 8
export const NAME_MAX = 14
export const DETENT = 2

/** Truncate or pad a label to exactly `width` cells (ellipsis on overflow). */
export function fitLabel(label: string, width: number): string {
  if (label.length > width) return label.slice(0, Math.max(0, width - 1)) + "…"
  return label.padEnd(width)
}

/** Two-column row: label left, value right-aligned in VALUE_WIDTH cells. */
export function panelRow(label: string, value: string, labelWidth: number): string {
  return fitLabel(label, labelWidth) + value.padStart(VALUE_WIDTH)
}

/**
 * Shared right edge for every money value: model rows are the widest layout
 * (indent + name + one gap + share zone + value), and every other row pads or
 * trims its label so its value ends on that same column. One edge, no ragged
 * right margin across row types.
 */
export function valueEdge(nameWidth: number): number {
  return DETENT + nameWidth + 1 + SHARE_ZONE_WIDTH + VALUE_WIDTH
}

/** Label width that right-aligns a panelRow value at `edge` on a row indented `indent` cells. */
export function labelWidthToEdge(edge: number, indent: number): number {
  return Math.max(1, edge - indent - VALUE_WIDTH)
}

/** Section header like `── Cost · API est. ────────` padded to `width`. */
export function sectionHeader(title: string, width: number): string {
  const text = ` ${title} `
  const right = Math.max(0, width - text.length - 2)
  return "──" + text + "─".repeat(right)
}

/** Brand shown bold in the panel header. */
export const HEADER_BRAND = "OpencodeBar"
/** Full header title: brand plus qualifier. */
export const HEADER_TITLE = `${HEADER_BRAND} · API est.`

/**
 * Brand header split into `[lead, brand, tail]` so the UI can render the
 * brand as one bold span. Concatenating the pieces always reproduces
 * sectionHeader(HEADER_TITLE, width) exactly; the natural (unpadded) width
 * is 26 cells, inside the 34-column panel budget.
 */
export function sectionHeaderParts(width: number): [string, string, string] {
  const full = sectionHeader(HEADER_TITLE, width)
  const lead = full.slice(0, full.indexOf(HEADER_BRAND))
  const tail = full.slice(lead.length + HEADER_BRAND.length)
  return [lead, HEADER_BRAND, tail]
}

/** Truncate a diagnostic line to `width` cells, marking cuts with an ellipsis. */
export function truncateWithEllipsis(text: string, width: number): string {
  if (text.length <= width) return text
  return text.slice(0, Math.max(0, width - 1)) + "…"
}

/**
 * Share-of-family-total bar: exactly 7 cells — a 3-cell `▇` bar (filled =
 * round(share*3), minimum 1 when drawn), a gap, and a right-aligned integer
 * percent. `100%` borrows the gap cell so every drawn zone stays 7 cells.
 * Drawn whenever the family total is positive and at least one model is
 * priced, so the common single-model session shows a full `▇▇▇100%` zone;
 * returns the empty string only when there is no positive total to share.
 */
export function shareBar(usd: number, totalUsd: number, contenders: number): string {
  if (contenders < 1 || totalUsd <= 0) return ""
  const share = usd / totalUsd
  const filled = Math.max(1, Math.round(share * SHARE_BAR_CELLS))
  const percent = Math.round(share * 100)
  return "▇".repeat(Math.min(SHARE_BAR_CELLS, filled)).padEnd(SHARE_BAR_CELLS) + `${percent}%`.padStart(SHARE_ZONE_WIDTH - SHARE_BAR_CELLS)
}

/** Sparkline ramp: 7 block levels, low to high (a zero day renders a space). */
const SPARK_RAMP = "▁▂▃▄▅▆▇"

/**
 * Weekly timeline: one cell per input day (slot 0 = 6 days ago … last =
 * today). Each day's level is `round(sqrt(value/max) * 6)` — a square-root
 * curve, so the max day always renders `▇` while low-spend days read taller
 * than a linear ramp would draw them and stay visible next to a spike. A
 * zero day renders a space. All-zero input renders one space per day;
 * empty input renders the empty string.
 */
export function sparklineBlocks(days: readonly number[]): string {
  if (days.length === 0) return ""
  const max = days.reduce((highest, value) => Math.max(highest, value), 0)
  if (max <= 0) return " ".repeat(days.length)
  return days
    .map((value) => (value <= 0 ? " " : SPARK_RAMP[Math.round(Math.sqrt(value / max) * (SPARK_RAMP.length - 1))]))
    .join("")
}

/**
 * Adaptive USD precision for money that spans orders of magnitude: 2 decimals
 * from $100, 3 from $1, 4 below. Keeps the value inside VALUE_WIDTH cells
 * without losing signal on cheap sessions.
 */
export function formatUSDAdaptive(amount: number): string {
  if (amount >= 100) return formatUSD(amount, 2)
  if (amount >= 1) return formatUSD(amount, 3)
  return formatUSD(amount, 4)
}

/**
 * Project "today" line: ` Today $X` plus ` · saved $Y` only when the
 * savings are positive. Adaptive precision keeps typical rows compact; at
 * extreme values the combined line is trimmed to the panel width (the
 * widest case, today ≥ $10000 plus saved ≥ $100000, is 35 cells raw).
 */
export function todayLine(todayUsd: number, savedUsd: number): string {
  const head = ` Today ${formatUSDAdaptive(todayUsd)}`
  if (savedUsd <= 0) return head
  return truncateWithEllipsis(`${head} · saved ${formatUSDAdaptive(savedUsd)}`, PANEL_WIDTH)
}

/** Billed-output token view: reasoning is part of output pricing. */
export function billedOutput(tokens: TokenUsage): number {
  return tokens.output + tokens.reasoning
}

/** Token detail line with icons, e.g. `↓ 1.2M · ↑ 340k · ↺ 8.1M`. */
export function tokenDetail(tokens: TokenUsage): string {
  const cache = tokens.cache.read + tokens.cache.write
  return `↓ ${formatTokens(tokens.input)} · ↑ ${formatTokens(billedOutput(tokens))} · ↺ ${formatTokens(cache)}`
}
