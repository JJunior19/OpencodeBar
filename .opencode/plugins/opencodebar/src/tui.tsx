/**
 * opencodebar TUI plugin: API-equivalent cost panel for the sidebar.
 *
 * All OpenCode interaction lives here and in ./ui; pricing and aggregation
 * logic stay pure in ./pricing and ./cost. The panel recomputes on usage
 * events, on session selection changes, and on a 30s tick.
 */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import {
  PROJECT_WINDOW_MS,
  computeTokenCost,
  formatAge,
  isInProjectWindow,
  rollupFamily,
  shouldStopProjectPagination,
  type UsageInput,
} from "./cost"
import { lookupPrice, parseLiteLLMPrices, type PriceEntry } from "./pricing"
import { CostPanel, type CostPanelTheme, type PanelController, type PriceStatusView, type ProjectTotalView } from "./ui"

const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
const PRICE_REFRESH_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const PROJECT_TTL_MS = 60_000
const PANEL_TICK_MS = 30_000
const PROJECT_PAGE_LIMIT = 50
const PROJECT_FETCH_CONCURRENCY = 4

interface PriceCache {
  fetchedAt: number
  entries: Record<string, PriceEntry>
  error: string
}

interface ProjectCache {
  projectID: string
  computedAt: number
  dirty: boolean
  total: number
  sessions: number
}

export default Plugin.define({
  id: "opencodebar",
  setup(context) {
    // ----- price cache (durable, 24h refresh, stale kept on failure) -----

    const [prices, updatePrices] = context.storage.store("prices", {
      initial: { fetchedAt: 0, entries: {}, error: "" } as PriceCache,
    })
    let priceFetch: Promise<boolean> | undefined

    async function fetchPrices(): Promise<boolean> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(LITELLM_URL, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const json: unknown = await response.json()
        const entries = parseLiteLLMPrices(json)
        if (Object.keys(entries).length === 0) throw new Error("empty price table")
        await updatePrices((draft) => {
          draft.fetchedAt = Date.now()
          draft.entries = entries
          draft.error = ""
        })
        return true
      } catch (error) {
        // Keep the stale table and its fetchedAt; surface the failure in the UI.
        const message = error instanceof Error ? error.message : String(error)
        await updatePrices((draft) => {
          draft.error = message
        })
        return false
      } finally {
        clearTimeout(timeout)
      }
    }

    function ensurePrices(): void {
      const fresh = Date.now() - prices.fetchedAt < PRICE_REFRESH_MS && Object.keys(prices.entries).length > 0
      if (!fresh && priceFetch === undefined) priceFetch = fetchPrices().finally(() => (priceFetch = undefined))
    }

    function forceRefreshPrices(): Promise<boolean> {
      if (priceFetch === undefined) priceFetch = fetchPrices().finally(() => (priceFetch = undefined))
      return priceFetch
    }

    ensurePrices()

    const lookup = (providerID: string, modelID: string): PriceEntry | undefined => {
      const result = lookupPrice(prices.entries, providerID, modelID)
      return result.matched ? result.entry : undefined
    }

    function priceStatus(): PriceStatusView {
      const entryCount = Object.keys(prices.entries).length
      if (entryCount === 0 && priceFetch !== undefined) return { state: "loading", label: "prices: loading" }
      if (entryCount === 0 && prices.error !== "") {
        return { state: "unavailable", label: `prices: unavailable (${prices.error})` }
      }
      if (prices.error !== "") {
        return { state: "error", label: `prices: fetch failed, cache ${formatAge(Date.now() - prices.fetchedAt)}` }
      }
      return { state: "ok", label: `prices: ${formatAge(Date.now() - prices.fetchedAt)}` }
    }

    // ----- reactivity -----

    const [revision, setRevision] = createSignal(0)
    const bump = () => setRevision((value) => value + 1)

    // ----- selected-session family report -----

    const syncedSessions = new Set<string>()

    function collectUsages(sessionID: string): UsageInput[] {
      const messages = context.data.session.message.list(sessionID)
      if (messages.length === 0 && !syncedSessions.has(sessionID)) {
        // First sighting of a family member (often a subagent): pull its
        // messages, then bump so the panel recomputes. Bounded: once per
        // session per plugin lifetime.
        syncedSessions.add(sessionID)
        void context.data.session.message
          .sync(sessionID)
          .then(() => bump())
          .catch(() => {})
      }
      const usages: UsageInput[] = []
      for (const message of messages) {
        if (message.type !== "assistant" || message.tokens === undefined) continue
        usages.push({
          model: { providerID: message.model.providerID, id: message.model.id },
          tokens: message.tokens,
        })
      }
      return usages
    }

    function sessionReport(sessionID: string) {
      const rootID = context.data.session.root(sessionID)
      const family = context.data.session.family(sessionID)
      return rollupFamily(
        family.map((id) => ({ sessionID: id, usages: collectUsages(id) })),
        rootID,
        lookup,
      )
    }

    // ----- 7-day project total (60s TTL, invalidated by usage events) -----

    let projectCache: ProjectCache | undefined
    let projectCompute: Promise<void> | undefined

    async function computeProjectTotalFromStats(projectID: string): Promise<{ total: number; sessions: number } | undefined> {
      try {
        const stats = await context.client.session.stats({
          project: projectID,
          from: Date.now() - PROJECT_WINDOW_MS,
        })
        if (stats.models.length === 0) return undefined
        let total = 0
        for (const model of stats.models) {
          total += computeTokenCost(model.tokens, lookup(model.model.providerID, model.model.id))
        }
        return { total, sessions: stats.sessions }
      } catch {
        return undefined
      }
    }

    /** Prescribed fallback: paginate newest-first, then fetch messages with bounded concurrency. */
    async function computeProjectTotalFromSessions(projectID: string): Promise<{ total: number; sessions: number }> {
      const now = Date.now()
      const sessionIDs: string[] = []
      let cursor: string | undefined
      let stop = false
      while (!stop) {
        const page = await context.client.session.list({
          project: projectID,
          order: "desc",
          limit: PROJECT_PAGE_LIMIT,
          cursor,
        })
        for (const session of page.data) {
          if (shouldStopProjectPagination(session.time.created, now, sessionIDs.length)) {
            stop = true
            break
          }
          if (isInProjectWindow(session.time.created, now)) sessionIDs.push(session.id)
        }
        cursor = page.cursor.next ?? undefined
        if (cursor === undefined || stop) break
      }

      let total = 0
      const queue = [...sessionIDs]
      const workers = Array.from({ length: Math.min(PROJECT_FETCH_CONCURRENCY, queue.length) }, async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          try {
            const messages = await context.client.session.context({ sessionID: id })
            for (const message of messages) {
              if (message.type !== "assistant" || message.tokens === undefined) continue
              total += computeTokenCost(
                message.tokens,
                lookup(message.model.providerID, message.model.id),
              )
            }
          } catch {
            // A single unreadable session must not sink the project total.
          }
        }
      })
      await Promise.all(workers)
      return { total, sessions: sessionIDs.length }
    }

    async function computeProjectTotal(projectID: string): Promise<{ total: number; sessions: number }> {
      return (await computeProjectTotalFromStats(projectID)) ?? (await computeProjectTotalFromSessions(projectID))
    }

    function ensureProjectTotal(projectID: string): void {
      const cached = projectCache
      const now = Date.now()
      if (cached !== undefined && cached.projectID === projectID && !cached.dirty && now - cached.computedAt < PROJECT_TTL_MS) {
        return
      }
      if (projectCompute === undefined) {
        projectCompute = computeProjectTotal(projectID)
          .then((result) => {
            projectCache = { projectID, computedAt: Date.now(), dirty: false, total: result.total, sessions: result.sessions }
            bump()
          })
          .catch(() => {})
          .finally(() => (projectCompute = undefined))
      }
    }

    function projectTotal(sessionID: string): ProjectTotalView {
      // The TUI location has no project ID in v2; follow the selected session.
      const session = context.data.session.get(sessionID)
      if (session === undefined) return { state: "loading", total: 0, sessionCount: 0 }
      ensureProjectTotal(session.projectID)
      const cached = projectCache
      if (cached !== undefined && cached.projectID === session.projectID) {
        return { state: "ok", total: cached.total, sessionCount: cached.sessions }
      }
      return { state: "loading", total: 0, sessionCount: 0 }
    }

    // ----- events, tick, slash command, slot -----

    const stops: Array<() => void> = [
      context.data.on("session.usage.updated", () => {
        // Covers model turns and auxiliary generation: the aggregate moves.
        if (projectCache !== undefined) projectCache.dirty = true
        bump()
      }),
      context.data.on("session.deleted", () => bump()),
    ]

    const tick = setInterval(() => {
      ensurePrices()
      bump()
    }, PANEL_TICK_MS)

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencodebar.refresh",
          title: "opencodebar: refresh LiteLLM prices",
          group: "opencodebar",
          slash: { name: "opencodebar", arguments: true },
          run: async (input) => {
            const argument = (input ?? "").trim()
            if (argument !== "" && argument !== "refresh") {
              context.ui.toast.show({ message: "Usage: /opencodebar refresh", variant: "info" })
              return
            }
            const ok = await forceRefreshPrices()
            if (ok) {
              context.ui.toast.show({
                message: `LiteLLM prices refreshed (${Object.keys(prices.entries).length} models, ${formatAge(0)})`,
                variant: "success",
              })
            } else {
              context.ui.toast.show({ message: `Price refresh failed: ${prices.error}`, variant: "error" })
            }
            bump()
          },
        },
      ],
    }))

    const controller: PanelController = { revision, sessionReport, projectTotal, priceStatus }

    const theme: CostPanelTheme = {
      text: context.theme.text.base,
      muted: context.theme.text.muted,
      error: context.theme.text.feedback.error.base,
      warning: context.theme.text.feedback.warning.base,
    }

    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <CostPanel sessionID={input.sessionID} ctrl={controller} theme={theme} />,
    })

    return () => {
      clearInterval(tick)
      stopSlot()
      for (const stop of stops) stop()
    }
  },
})
