# Feature: opencodebar — Cost Tracker Plugin for OpenCode v2

## Objective
Build an OpenCode v2 plugin that tracks session cost (including all subagent
sessions), shown in the TUI sidebar, computing **API-equivalent cost** from raw
token usage × LiteLLM list prices (refreshed once per day).

## Problem / Why
OpenCode's built-in cost reflects its own price table and is meaningless for
users on coding plans (subscriptions). The user wants to know what each session
*would have cost* via API list prices. LiteLLM's public pricing JSON is the
chosen single source of truth, cached with a 24h refresh.

## Key requirements
- Per-model breakdown within a session (model switches mid-session included).
- Subagent costs (sessions with `parentID`) rolled into the root session total,
  with their own per-model lines.
- Session total + project total for the last 7 days.
- Prices from LiteLLM (`model_prices_and_context_window.json`), cached in
  durable plugin storage, refreshed at most once per 24h, stale cache kept on
  fetch failure with visible age.
- Models not present in LiteLLM data are shown with token counts and a "no
  price" marker; never guessed prices.

## Verified API facts (evidence gathered 2026-10-04)
- `Session.Message.Assistant` carries per-message `model` (`providerID`, `id`,
  `variant`), `agent`, `tokens` (`input`, `output`, `reasoning`,
  `cache.read`, `cache.write`), and built-in `cost` (USD).
- `Session.Info` carries `parentID`, `projectID`, `time.created/updated`, and
  aggregate `cost`/`tokens`.
- `GET /api/session` supports `project`, `order=desc`, `limit`, cursor
  pagination; `GET /api/session/{id}/message` lists messages.
- CLI plugin API: `context.data.session.{root,family,message.list}`,
  `context.data.on(...)`, `context.ui.slot({ append: "sidebar.content" })`,
  `context.storage.store()` (durable), `context.theme`, `context.client`.
- Docs: https://opencode.ai/v2/docs/build/plugins + /build/plugins/cli

## Scope
- Plugin lives self-contained at `opencodebar/` (auto-loaded
  in this repo; publishable package layout with `./tui` export).
- Pure logic (`pricing.ts`, `cost.ts`) fully unit-tested with vitest
  (RED → GREEN). TUI layer verified by typecheck + load check (no deterministic
  runner for OpenTUI rendering — documented exception).

## Constraints / decisions
- Reasoning tokens ARE billed as output (`includeReasoning` defaults true).
  Empirically validated T5: excluding them undercounts reasoning-heavy
  sessions ~55%; including matches built-in cost within 0.011%.
- Cost formula: `input×input_price + output×output_price + cache.read×cache_read
  + cache.write×cache_write` (USD per token from LiteLLM).
- 7-day aggregation capped at 200 newest sessions, 60s TTL recompute cache.
- English for all artifacts; Conventional Commits; no AI attribution.
- RDD: off (global). Ordinary checks apply.

## Delivery strategy
No remote configured → no PR flow. Feature branch `feat/cost-tracker-plugin`,
work-unit commits per task, user merges to `master`. Forecast ≈ 650–750
authored lines (code + tests + docs) — over the 400 heuristic; single cohesive
MVP, splitting would harm coherence.

## Tasks
- [x] T1 — Scaffold plugin package. Commit `8507a1b`. Route: delegated writer.
- [x] T2 — `pricing.ts` matching (exact → alias → bare, no fuzzy). RED→GREEN,
      12 tests. Commit `792dc4e`. Route: delegated writer.
- [x] T3 — `cost.ts` aggregation (family rollup, 7d window, cap 200). RED→GREEN,
      18 tests. Commit `4ada576`. Route: delegated writer.
- [x] T4 — TUI sidebar panel + price cache + `/opencodebar refresh`. Commit
      `a2d1df0`. Route: delegated writer.
- [x] T5 — README + verification (30/30 vitest, tsc clean, reasoning formula
      validated empirically). Commit `b1c7e03`. Route: delegated writer +
      parent spot check + independent verifier.

## Verification of record
- Writer: `npm install` (solid-js pinned 1.9.12 for peer), `vitest run` 30/30,
  `tsc --noEmit` clean, plugin-load probes (see blocker), reasoning check with
  numbers.
- Parent spot check: commits/formula/slot registration read back.
- Independent verifier (RDD off, tier high per unassessable assess): verdict
  issues-found, 0 blockers/majors, 3 minors → follow-ups below. Math, matching,
  aggregation, cleanup: PASS.

## Deviations from plan (accepted)
- Reasoning billed as output (evidence-driven flip, documented in cost.ts).
- Events: `session.usage.updated`/`session.deleted` (v2 wire names).
- projectID from SessionInfo (LocationRef lacks it).
- 7d total uses `client.session.stats` primary, pagination fallback kept.
- `.opencode/plugins/` auto-load NOT honored by server 2.0.22 (proven by
  private-serve log probe) — activation unresolved, see blocker.
- master unborn; root commit lives on the feature branch.

## Blocker: plugin activation — RESOLVED
- Root cause: OpenCode's discovery layout expects `index.ts` and `tui.ts`
  DIRECTLY at `.opencode/plugins/<name>/` — filename-based, not package.json
  exports. Our src/ layout was invisible to discovery (server AND TUI).
- Fixed in `0690f34`: root shims `index.ts`/`tui.ts` re-export src/ entries.
- Two follow-on runtime fixes (invisible to tsc/vitest, caught on TUI relaunch):
  storage key must not contain `/` (`31f9b33`); `keymap.layer` must register
  inside a component tree (`42c433d`).
- Confirmed working in the TUI by the user.

## Follow-ups
- [ ] F1 — Debounce project recompute: `session.usage.updated` sets dirty which
      bypasses the 60s TTL (minor, bounded by single-flight).
- [ ] F2 — Backoff for price fetch retries during persistent outages.
- [ ] F3 — Pin bare-id fallback behavior with a test (proxy/gpt-5-mini case).
- [x] F4 — Resolve activation: discovery-layout shims + runtime fixes; working
      in TUI (user-confirmed). Remaining: global install (currently project-local).

## Progress log
- 2026-10-04 — Feature doc created. Feasibility verified against live
  openapi.json. RDD off. Writer delegated for T1–T5.
- 2026-10-04 — T1–T5 complete (8507a1b..b1c7e03). Independent verifier: 0
  blockers. Activation blocker open (F4).
- 2026-10-04 — Activation resolved via discovery shims + 2 runtime fixes;
  dash-prefix cascade for coding-plan providers (6953032); panel redesign with
  bars/alignment/token detail (0862c09). User-confirmed working.

## Next step
User-owned: merge `feat/cost-tracker-plugin` into `master`; optional global
install so the plugin loads in every project (currently project-local).
