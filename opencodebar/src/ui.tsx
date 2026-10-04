/**
 * Sidebar cost panel components.
 *
 * Presentation only: no OpenCode imports, no I/O. The TUI plugin (./tui)
 * supplies a PanelController whose methods read reactive state; every
 * component below recomputes when the controller's signals change. String
 * builders live in ./format (JSX-free, unit-tested).
 *
 * Layout contract (compact, sidebar-safe, ~34 columns):
 *   ── Cost · API est. ─────────────
 *   Session              $12.3456
 *    ↓ 250k · ↑ 60k · ↺ 9.5M
 *     glm-5.3            ▇▇▇▇▇ $9.8765
 *      ↓ 1.2M · ↑ 340k · ↺ 8.1M
 *    · subagents (2): $0.4320
 *   Project · 7d           $45.67
 *   38 sessions · litellm · 2m ago
 */
import type { RGBA } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { formatUSD, type FamilyReport, type ModelUsage } from "./cost"
import {
  BAR_WIDTH,
  DETENT,
  NAME_MAX,
  NAME_MIN,
  VALUE_WIDTH,
  fitLabel,
  panelRow,
  sectionHeader,
  shareBar,
  tokenDetail,
} from "./format"

export interface PriceStatusView {
  readonly state: "loading" | "ok" | "error" | "unavailable"
  readonly label: string
}

export interface ProjectTotalView {
  readonly state: "loading" | "ok"
  readonly total: number
  readonly sessionCount: number
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

  const nameWidth = createMemo(() => {
    const longest = report().models.reduce((max, model) => Math.max(max, shortModelName(model.modelID).length), 0)
    return Math.min(NAME_MAX, Math.max(NAME_MIN, longest))
  })

  const rowLabelWidth = createMemo(() => {
    return Math.max("Project · 7d".length, DETENT + nameWidth())
  })

  const barContenders = createMemo(() => report().models.filter((model) => model.matched && model.usd > 0).length)
  const maxModelUsd = createMemo(() => report().models.reduce((max, model) => Math.max(max, model.usd), 0))

  return (
    <Show when={props.sessionID !== ""}>
      <box>
        <text fg={props.theme.text}>{sectionHeader("Cost · API est.", rowLabelWidth() + VALUE_WIDTH)}</text>
        <text fg={props.theme.text}>{panelRow("Session", formatUSD(report().total, 4), rowLabelWidth())}</text>
        <text fg={props.theme.muted}>{`${" ".repeat(DETENT + 1)}${tokenDetail(report().tokens)}`}</text>
        <For each={report().models}>
          {(model) => {
            const name = shortModelName(model.modelID)
            const bar = shareBar(model.usd, maxModelUsd(), barContenders()).padEnd(BAR_WIDTH)
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
                    {`${" ".repeat(DETENT)}${fitLabel(name, nameWidth())}${bar}${formatUSD(model.usd, 4).padStart(VALUE_WIDTH)}`}
                  </text>
                </Show>
                <text fg={props.theme.muted}>{`${" ".repeat(DETENT + 1)}${tokenDetail(model.tokens)}`}</text>
              </box>
            )
          }}
        </For>
        <Show when={report().subagents.count > 0}>
          <text fg={props.theme.muted}>
            {`${" ".repeat(DETENT)}· subagents (${report().subagents.count}): ${formatUSD(report().subagents.total, 4)}`}
          </text>
        </Show>
        <text fg={props.theme.text}>
          {panelRow("Project · 7d", project().state === "ok" ? formatUSD(project().total, 2) : "…", rowLabelWidth())}
        </text>
        <Show
          when={prices().state === "error" || prices().state === "unavailable"}
          fallback={
            <text fg={props.theme.muted}>
              {project().state === "ok" && project().sessionCount > 0
                ? `${project().sessionCount} sessions · ${prices().label}`
                : prices().label}
            </text>
          }
        >
          <text fg={props.theme.warning}>{prices().label}</text>
        </Show>
      </box>
    </Show>
  )
}
