/**
 * Sidebar cost panel components.
 *
 * Presentation only: no OpenCode imports, no I/O. The TUI plugin (./tui)
 * supplies a PanelController whose methods read reactive state; every
 * component below recomputes when the controller's signals change. String
 * builders live in ./format (JSX-free, unit-tested).
 *
 * Layout contract (compact, sidebar-safe, ≤ 34 columns). All money values
 * share ONE right edge (`valueEdge` = indent + name + gap + share zone +
 * value, 28–34 cells depending on the model-name width), so Session,
 * per-model, subagent, and Project rows read as a single aligned column:
 *   ── OpencodeBar · API est. ──────
 *   Session                  $12.3456
 *    ↓ 250k · ↑ 60k · ↺ 9.5M
 *    ↺ saved $1.03
 *   ! ctx: <family fetch error>…
 *     glm-5.3        ▇▇  50%    $9.876
 *      ↓ 1.2M · ↑ 340k · ↺ 8.1M
 *    · subagents (2):          $0.432
 *      explore-wor             $0.21
 *      cost-panel              $0.19
 *   Project · 7d             $45.67
 *    Today $4.196 · saved $12.40
 *    7d ▇▄▁
 *   ! <project total error>…
 *   13 sessions total
 *
 * The header renders `OpencodeBar` as a bold span (OpenTUI `<b>`); its
 * natural width (26 cells) can exceed the value-column edge but stays inside
 * the 34-column budget. The `7d ` sparkline under the project row shows one
 * block per local calendar day (6 days ago → today) of matched-model spend,
 * scaled by the square root of the day's share of the week's max so cheap
 * days stay readable next to a spike; the ` Today` line above it carries
 * today's spend plus the window's cache savings when positive. `!`/`! ctx:`
 * warning lines appear only while the matching async fetch is failing
 * (project value: "…" while loading, "!" while erroring). The footer shows
 * the count of sessions scanned for the project window; while the price
 * table has not loaded yet it reads "prices: loading", and price-fetch
 * failures replace it with a warning line.
 * Row widths: every value row ends at valueEdge (per-model rows reach it via
 * 2+14+1+7+10 = 34 cells at the widest name width); subagent names pad or trim
 * to the same edge (top 4 by cost, positive only); the today line trims
 * itself to 34.
 */
import type { RGBA } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { formatUSD, type ModelUsage, type NamedFamilyReport } from "./cost"
import {
  DETENT,
  NAME_MAX,
  NAME_MIN,
  PANEL_WIDTH,
  SHARE_ZONE_WIDTH,
  VALUE_WIDTH,
  fitLabel,
  formatUSDAdaptive,
  labelWidthToEdge,
  panelRow,
  sectionHeaderParts,
  shareBar,
  sparklineBlocks,
  todayLine,
  tokenDetail,
  truncateWithEllipsis,
  valueEdge,
} from "./format"

export interface PriceStatusView {
  readonly state: "loading" | "ok" | "error" | "unavailable"
  readonly label: string
  /** Price-cache age in ms; 0 while loading, erroring, or unavailable. */
  readonly ageMs: number
}

export interface ProjectTotalView {
  readonly state: "loading" | "ok" | "error"
  readonly total: number
  readonly sessionCount: number
  /** Spend per local calendar day, oldest first (slot 0 = 6 days ago); [] unless state is "ok". */
  readonly days: readonly number[]
  /** Cache savings across the project window; 0 while loading or erroring. */
  readonly saved: number
  /** Last failure message; "" unless state is "error". */
  readonly message: string
}

/** Reactive data surface the TUI plugin implements for the panel. */
export interface PanelController {
  /** Bumped whenever cached session data may have changed. */
  revision(): number
  /** Cost report for the selected session's family (subagent names resolved). */
  sessionReport(sessionID: string): NamedFamilyReport
  /** 7-day project total for the selected session's project (may trigger an async recompute). */
  projectTotal(sessionID: string): ProjectTotalView
  /** Price cache status for the footer line. */
  priceStatus(): PriceStatusView
  /** Last async fetch failures for on-panel diagnostics; "" means none. */
  errors(): { family: string; project: string }
}

export interface CostPanelTheme {
  readonly text: RGBA
  readonly muted: RGBA
  readonly error: RGBA
  readonly warning: RGBA
}

function shortModelName(modelID: string): string {
  const slash = modelID.lastIndexOf("/")
  return slash === -1 ? modelID : modelID.slice(slash + 1)
}

/** Fallback label for a subagent whose title has not resolved yet: the id body's first 8 chars. */
function shortSessionID(sessionID: string): string {
  const bare = sessionID.startsWith("ses_") ? sessionID.slice(4) : sessionID
  return bare.slice(0, 8)
}

export function CostPanel(props: {
  sessionID: string
  ctrl: PanelController
  theme: CostPanelTheme
}) {
  const report = createMemo(() => {
    void props.sessionID
    void props.ctrl.revision()
    return props.ctrl.sessionReport(props.sessionID)
  })

  const project = createMemo(() => {
    void props.sessionID
    void props.ctrl.revision()
    return props.ctrl.projectTotal(props.sessionID)
  })

  const prices = createMemo(() => props.ctrl.priceStatus())

  const errors = createMemo(() => {
    void props.ctrl.revision()
    return props.ctrl.errors()
  })

  const nameWidth = createMemo(() => {
    const longest = report().models.reduce((max, model) => Math.max(max, shortModelName(model.modelID).length), 0)
    return Math.min(NAME_MAX, Math.max(NAME_MIN, longest))
  })

  // Single shared value column: model rows define the widest layout, every
  // other row pads or trims its label so its value ends on the same column.
  const edge = createMemo(() => valueEdge(nameWidth()))

  const headerParts = createMemo(() => sectionHeaderParts(edge()))

  const barContenders = createMemo(() => report().models.filter((model) => model.matched && model.usd > 0).length)

  return (
    <Show when={props.sessionID !== ""}>
      <box>
        <text fg={props.theme.text}>{headerParts()[0]}<b>{headerParts()[1]}</b>{headerParts()[2]}</text>
        <text fg={props.theme.text}>{panelRow("Session", formatUSDAdaptive(report().total), labelWidthToEdge(edge(), 0))}</text>
        <text fg={props.theme.muted}>{`${" ".repeat(DETENT + 1)}${tokenDetail(report().tokens)}`}</text>
        <Show when={report().cacheSaved > 0}>
          <text fg={props.theme.muted}>{`${" ".repeat(DETENT + 1)}↺ saved ${formatUSDAdaptive(report().cacheSaved)}`}</text>
        </Show>
        <Show when={errors().family !== "" && report().models.length === 0 && report().total === 0}>
          <text fg={props.theme.warning}>{truncateWithEllipsis(`! ctx: ${errors().family}`, PANEL_WIDTH)}</text>
        </Show>
        <For each={report().models}>
          {(model) => {
            const name = shortModelName(model.modelID)
            const bar = shareBar(model.usd, report().total, barContenders()).padEnd(SHARE_ZONE_WIDTH)
            return (
              <box>
                <Show
                  when={model.matched}
                  fallback={
                    <text fg={props.theme.warning}>
                      {`${" ".repeat(DETENT)}${fitLabel(name, nameWidth())} ${bar}${"no price".padStart(VALUE_WIDTH)}`}
                    </text>
                  }
                >
                  <text fg={props.theme.muted}>
                    {`${" ".repeat(DETENT)}${fitLabel(name, nameWidth())} ${bar}${formatUSDAdaptive(model.usd).padStart(VALUE_WIDTH)}`}
                  </text>
                </Show>
                <text fg={props.theme.muted}>{`${" ".repeat(DETENT + 1)}${tokenDetail(model.tokens)}`}</text>
              </box>
            )
          }}
        </For>
        <Show when={report().subagents.count > 0}>
          <box>
            <text fg={props.theme.muted}>
              {panelRow(`· subagents (${report().subagents.count}):`, formatUSDAdaptive(report().subagents.total), labelWidthToEdge(edge(), DETENT))}
            </text>
            <For each={report().subagents.items.filter((item) => item.usd > 0).slice(0, 4)}>
              {(item) => (
                <text fg={props.theme.muted}>
                  {`${" ".repeat(DETENT + 1)}${panelRow(item.name !== "" ? item.name : shortSessionID(item.sessionID), formatUSDAdaptive(item.usd), labelWidthToEdge(edge(), DETENT + 1))}`}
                </text>
              )}
            </For>
          </box>
        </Show>
        <text fg={props.theme.text}>
          {panelRow(
            "Project · 7d",
            project().state === "ok" ? formatUSD(project().total, 2) : project().state === "error" ? "!" : "…",
            labelWidthToEdge(edge(), 0),
          )}
        </text>
        <Show when={project().state === "ok" && project().total > 0}>
          <box>
            <text fg={props.theme.muted}>{todayLine(project().days[6] ?? 0, project().saved)}</text>
            <text fg={props.theme.muted}>{`7d ${sparklineBlocks(project().days)}`}</text>
          </box>
        </Show>
        <Show when={project().state === "error"}>
          <text fg={props.theme.warning}>{truncateWithEllipsis(`! ${project().message}`, PANEL_WIDTH)}</text>
        </Show>
        <Show
          when={prices().state === "error" || prices().state === "unavailable"}
          fallback={
            <text fg={props.theme.muted}>
              {prices().state === "loading"
                ? prices().label
                : `${project().state === "ok" ? project().sessionCount : 0} sessions total`}
            </text>
          }
        >
          <text fg={props.theme.warning}>{prices().label}</text>
        </Show>
      </box>
    </Show>
  )
}
