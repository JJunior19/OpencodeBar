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
  if (label.length >= width) return label.slice(0, Math.max(0, width - 1)) + "…"
  return label.padEnd(width)
}

/** Two-column row: label left, value right-aligned in VALUE_WIDTH cells. */
export function panelRow(label: string, value: string, labelWidth: number): string {
  return fitLabel(label, labelWidth) + value.padStart(VALUE_WIDTH)
}

/** Section header like `── Cost · API est. ────────` padded to `width`. */
export function sectionHeader(title: string, width: number): string {
  const text = ` ${title} `
  const right = Math.max(0, width - text.length - 2)
  return "──" + text + "─".repeat(right)
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
 * Returns the empty string when there is nothing to compare against (fewer
 * than two priced models or a zero total), so the panel skips visual noise
 * instead of drawing a meaningless full bar.
 */
export function shareBar(usd: number, totalUsd: number, contenders: number): string {
  if (contenders < 2 || totalUsd <= 0) return ""
  const share = usd / totalUsd
  const filled = Math.max(1, Math.round(share * SHARE_BAR_CELLS))
  const percent = Math.round(share * 100)
  return "▇".repeat(Math.min(SHARE_BAR_CELLS, filled)).padEnd(SHARE_BAR_CELLS) + `${percent}%`.padStart(SHARE_ZONE_WIDTH - SHARE_BAR_CELLS)
}

/**
 * Footer line with the `· r<N>` reactivity heartbeat appended. The body is
 * trimmed with an ellipsis when needed; the heartbeat is never cut, so the
 * probe stays visible even for long price-status labels.
 */
export function heartbeatFooter(body: string, revision: number, width: number = PANEL_WIDTH): string {
  const heartbeat = ` · r${revision}`
  return truncateWithEllipsis(body, width - heartbeat.length) + heartbeat
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

/** Billed-output token view: reasoning is part of output pricing. */
export function billedOutput(tokens: TokenUsage): number {
  return tokens.output + tokens.reasoning
}

/** Token detail line with icons, e.g. `↓ 1.2M · ↑ 340k · ↺ 8.1M`. */
export function tokenDetail(tokens: TokenUsage): string {
  const cache = tokens.cache.read + tokens.cache.write
  return `↓ ${formatTokens(tokens.input)} · ↑ ${formatTokens(billedOutput(tokens))} · ↺ ${formatTokens(cache)}`
}
