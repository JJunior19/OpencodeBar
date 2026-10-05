/**
 * Sidebar cost panel components.
 *
 * Presentation only: no OpenCode imports, no I/O. The TUI plugin (./tui)
 * supplies a PanelController whose methods read reactive state; every
 * component below recomputes when the controller's signals change. String
 * builders live in ./format (JSX-free, unit-tested).
 *
 * Layout contract (compact, sidebar-safe, ≤ 34 columns):
 *   ── Cost · API est. ──────────
 *   Session           $12.3456
 *    ↓ 250k · ↑ 60k · ↺ 9.5M
 *   ! ctx: <family fetch error>…
 *     glm-5.3        ▇▇  50%    $9.876
 *      ↓ 1.2M · ↑ 340k · ↺ 8.1M
 *    · subagents (2): $0.432
 *   Project · 7d          $45.67
 *   ! <project total error>…
 *   38 sessions · prices: 2m old · r7
 *
 * `!`/`! ctx:` warning lines appear only while the matching async fetch is
 * failing (project value: "…" while loading, "!" while erroring). The `r<N>`
 * footer heartbeat is the reactivity probe: N is the controller revision and
 * must advance across 30s ticks — a frozen N means the signal graph is dead.
 * Per-model row budget: 2 (detent) + 14 (name) + 7 (share zone) + 10
 * (value) = 33 cells.
 */
import type { RGBA } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { formatUSD, type FamilyReport, type ModelUsage } from "./cost"
import {
  DETENT,
  NAME_MAX,
  NAME_MIN,
  PANEL_WIDTH,
  SHARE_ZONE_WIDTH,
  VALUE_WIDTH,
  fitLabel,
  formatUSDAdaptive,
  heartbeatFooter,
  panelRow,
  sectionHeader,
  shareBar,
  tokenDetail,
  truncateWithEllipsis,
} from "./format"

export interface PriceStatusView {
  readonly state: "loading" | "ok" | "error" | "unavailable"
  readonly label: string
}

export interface ProjectTotalView {
  readonly state: "loading" | "ok" | "error"
  readonly total: number
  readonly sessionCount: number
  /** Last failure message; "" unless state is "error". */
  readonly message: string
}

/** Reactive data surface the TUI plugin implements for the panel. */
export interface PanelController {
  /** Bumped whenever cached session data may have changed. */
  revision(): number
  /** Cost report for the selected session's whole family. */
  sessionReport(sessionID: string): FamilyReport
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

  const rowLabelWidth = createMemo(() => {
    return Math.max("Project · 7d".length, DETENT + nameWidth())
  })

  const barContenders = createMemo(() => report().models.filter((model) => model.matched && model.usd > 0).length)

  return (
    <Show when={props.sessionID !== ""}>
      <box>
        <text fg={props.theme.text}>{sectionHeader("Cost · API est.", rowLabelWidth() + VALUE_WIDTH)}</text>
        <text fg={props.theme.text}>{panelRow("Session", formatUSDAdaptive(report().total), rowLabelWidth())}</text>
        <text fg={props.theme.muted}>{`${" ".repeat(DETENT + 1)}${tokenDetail(report().tokens)}`}</text>
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
                      {`${" ".repeat(DETENT)}${fitLabel(name, nameWidth())}${bar}${"no price".padStart(VALUE_WIDTH)}`}
                    </text>
                  }
                >
                  <text fg={props.theme.muted}>
                    {`${" ".repeat(DETENT)}${fitLabel(name, nameWidth())}${bar}${formatUSDAdaptive(model.usd).padStart(VALUE_WIDTH)}`}
                  </text>
                </Show>
                <text fg={props.theme.muted}>{`${" ".repeat(DETENT + 1)}${tokenDetail(model.tokens)}`}</text>
              </box>
            )
          }}
        </For>
        <Show when={report().subagents.count > 0}>
          <text fg={props.theme.muted}>
            {`${" ".repeat(DETENT)}· subagents (${report().subagents.count}): ${formatUSDAdaptive(report().subagents.total)}`}
          </text>
        </Show>
        <text fg={props.theme.text}>
          {panelRow(
            "Project · 7d",
            project().state === "ok" ? formatUSD(project().total, 2) : project().state === "error" ? "!" : "…",
            rowLabelWidth(),
          )}
        </text>
        <Show when={project().state === "error"}>
          <text fg={props.theme.warning}>{truncateWithEllipsis(`! ${project().message}`, PANEL_WIDTH)}</text>
        </Show>
        <Show
          when={prices().state === "error" || prices().state === "unavailable"}
          fallback={
            <text fg={props.theme.muted}>
              {heartbeatFooter(
                project().state === "ok" && project().sessionCount > 0
                  ? `${project().sessionCount} sessions · ${prices().label}`
                  : prices().label,
                props.ctrl.revision(),
              )}
            </text>
          }
        >
          <text fg={props.theme.warning}>{heartbeatFooter(prices().label, props.ctrl.revision())}</text>
        </Show>
      </box>
    </Show>
  )
}
