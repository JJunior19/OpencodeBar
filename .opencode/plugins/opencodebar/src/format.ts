/**
 * Pure string builders for the sidebar cost panel.
 *
 * JSX-free on purpose: vitest can import this module directly, while the
 * component file (./ui) needs OpenTUI's preserve-mode JSX transform.
 */
import { formatTokens, type TokenUsage } from "./cost"

export const VALUE_WIDTH = 10
export const BAR_WIDTH = 5
export const NAME_MIN = 8
export const NAME_MAX = 16
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

/**
 * Proportional bar for a model's share of the session cost. Returns the
 * empty string when there is nothing to compare against (single priced model
 * or zero cost), so the panel skips visual noise instead of drawing a
 * meaningless full bar.
 */
export function shareBar(usd: number, maxUsd: number, contenders: number): string {
  if (contenders < 2 || maxUsd <= 0) return ""
  const filled = Math.max(1, Math.round((usd / maxUsd) * BAR_WIDTH))
  return "▇".repeat(Math.min(BAR_WIDTH, filled))
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
