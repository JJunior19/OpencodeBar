/**
 * Sidebar cost panel components.
 *
 * Presentation only: no OpenCode imports, no I/O. The TUI plugin (./tui)
 * supplies a PanelController whose methods read reactive state; every
 * component below recomputes when the controller's signals change.
 */
import type { RGBA } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { formatTokens, formatUSD, type FamilyReport, type ModelUsage } from "./cost"

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

function totalTokens(model: ModelUsage): number {
  return model.tokens.input + model.tokens.output + model.tokens.reasoning + model.tokens.cache.read + model.tokens.cache.write
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

  const modelColumnWidth = createMemo(() =>
    Math.max(...report().models.map((model) => shortModelName(model.modelID).length), 0),
  )

  return (
    <Show when={props.sessionID !== ""}>
      <box>
        <text fg={props.theme.text}>{`Session (API est.): ${formatUSD(report().total, 4)}`}</text>
        <For each={report().models}>
          {(model) => (
            <text fg={props.theme.muted}>
              {model.matched
                ? `  ${shortModelName(model.modelID).padEnd(modelColumnWidth())}  ${formatUSD(model.usd, 4)}`
                : `  ${shortModelName(model.modelID).padEnd(modelColumnWidth())}  no price (${formatTokens(totalTokens(model))} tok)`}
            </text>
          )}
        </For>
        <Show when={report().subagents.count > 0}>
          <text fg={props.theme.text}>{`Subagents (${report().subagents.count}): ${formatUSD(report().subagents.total, 4)}`}</text>
        </Show>
        <text fg={props.theme.text}>
          {`Project (7d): ${project().state === "ok" ? formatUSD(project().total, 2) : "..."}`}
        </text>
        <Show
          when={prices().state === "error" || prices().state === "unavailable"}
          fallback={<text fg={props.theme.muted}>{prices().label}</text>}
        >
          <text fg={props.theme.warning}>{prices().label}</text>
        </Show>
      </box>
    </Show>
  )
}
