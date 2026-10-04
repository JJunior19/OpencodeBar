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
const FAMILY_REFRESH_MS = 5_000
const PROJECT_PAGE_LIMIT = 50
const PROJECT_FETCH_CONCURRENCY = 4

interface PriceCache {
  fetchedAt: number
  entries: Record<string, PriceEntry>
  error: string
}

interface ProjectCache {
  directory: string
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

    // `data.session.message.list` is page-limited, so it under-counts sessions
    // whose transcript spans more than one page. `client.session.context`
    // returns the full transcript (verified: it paginates internally). We fetch
    // it async, cache per session, and refresh on usage events and on the tick,
    // guarded by a minimum refresh interval so streaming does not storm.
    const familyUsages = new Map<string, { usages: UsageInput[]; fetchedAt: number }>()
    const familyInflight = new Set<string>()
    let viewedSessionID = ""

    async function fetchUsages(sessionID: string): Promise<void> {
      const messages = await context.client.session.context({ sessionID })
      const usages: UsageInput[] = []
      for (const message of messages) {
        if (message.type !== "assistant" || message.tokens === undefined) continue
        usages.push({
          model: { providerID: message.model.providerID, id: message.model.id },
          tokens: message.tokens,
        })
      }
      familyUsages.set(sessionID, { usages, fetchedAt: Date.now() })
      bump()
    }

    function scheduleUsages(sessionID: string): void {
      const entry = familyUsages.get(sessionID)
      if (entry !== undefined && Date.now() - entry.fetchedAt < FAMILY_REFRESH_MS) return
      if (familyInflight.has(sessionID)) return
      familyInflight.add(sessionID)
      void fetchUsages(sessionID)
        .catch(() => {})
        .finally(() => familyInflight.delete(sessionID))
    }

    function sessionReport(sessionID: string) {
      viewedSessionID = sessionID
      const rootID = context.data.session.root(sessionID)
      const family = context.data.session.family(sessionID)
      for (const id of family) scheduleUsages(id)
      return rollupFamily(
        family.map((id) => ({ sessionID: id, usages: familyUsages.get(id)?.usages ?? [] })),
        rootID,
        lookup,
      )
    }

    // ----- 7-day project total (60s TTL, invalidated by usage events) -----

    let projectCache: ProjectCache | undefined
    let projectCompute: Promise<void> | undefined

    // Group the project total by DIRECTORY, not projectID: OpenCode can assign
    // different projectIDs to sessions in the same directory (project
    // re-detection), which fragments the total across two IDs. The directory is
    // the stable grouping key. `session.stats` only filters by project, so we
    // paginate sessions by directory and sum their messages instead.
    async function computeProjectTotalForDirectory(directory: string): Promise<{ total: number; sessions: number }> {
      const now = Date.now()
      const sessionIDs: string[] = []
      let cursor: string | undefined
      let stop = false
      while (!stop) {
        const page = await context.client.session.list({
          directory,
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

    function ensureProjectTotal(directory: string): void {
      const cached = projectCache
      const now = Date.now()
      if (cached !== undefined && cached.directory === directory && !cached.dirty && now - cached.computedAt < PROJECT_TTL_MS) {
        return
      }
      if (projectCompute === undefined) {
        projectCompute = computeProjectTotalForDirectory(directory)
          .then((result) => {
            projectCache = { directory, computedAt: Date.now(), dirty: false, total: result.total, sessions: result.sessions }
            bump()
          })
          .catch(() => {})
          .finally(() => (projectCompute = undefined))
      }
    }

    function projectTotal(sessionID: string): ProjectTotalView {
      // Group by the session's directory: projectID can fragment across
      // re-detection, while the directory is stable.
      const session = context.data.session.get(sessionID)
      if (session === undefined) return { state: "loading", total: 0, sessionCount: 0 }
      const directory = session.location.directory
      ensureProjectTotal(directory)
      const cached = projectCache
      if (cached !== undefined && cached.directory === directory) {
        return { state: "ok", total: cached.total, sessionCount: cached.sessions }
      }
      return { state: "loading", total: 0, sessionCount: 0 }
    }

    // ----- events, tick, slash command, slot -----

    const stops: Array<() => void> = [
      context.data.on("session.usage.updated", () => {
        // Covers model turns and auxiliary generation: the aggregate moves.
        if (projectCache !== undefined) projectCache.dirty = true
        if (viewedSessionID !== "") {
          for (const id of context.data.session.family(viewedSessionID)) scheduleUsages(id)
        }
        bump()
      }),
      context.data.on("session.deleted", () => bump()),
    ]

    const tick = setInterval(() => {
      ensurePrices()
      if (viewedSessionID !== "") {
        for (const id of context.data.session.family(viewedSessionID)) scheduleUsages(id)
      }
      bump()
    }, PANEL_TICK_MS)

    // Keymap layers need the Keymap.Provider that only exists inside the
    // component tree, so the command is registered from an "app" slot render
    // (returns null; purely a registration host) per the documented pattern.
    const stopKeymapSlot = context.ui.slot({
      append: "app",
      render: () => {
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
        return null
      },
    })

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
      stopKeymapSlot()
      for (const stop of stops) stop()
    }
  },
})
