# opencodebar

API-equivalent cost tracking for [OpenCode](https://opencode.ai) v2, shown in
the TUI sidebar.

OpenCode's built-in cost comes from its own price table and reads `$0` for
coding-plan subscriptions. opencodebar answers the question plan subscribers
actually have: **what would this session have cost via API list prices?** It
multiplies raw token usage by [LiteLLM](https://github.com/BerriAI/litellm)'s
public per-token pricing, cached locally with a 24h refresh.

## What the panel shows

For the selected session (including every subagent session in its family):

```
── OpencodeBar · API est. 
Session           $0.1234
 ↓ 250k · ↑ 60k · ↺ 9.5M
 ↺ saved $0.0135
  claude-sonnet… ▇▇  67%     $0.082
  gpt-5-mini     ▇    8%     $0.010
  internal-model ▇    0% no price
 · subagents (2): $0.031
  explore-wor          $0.021
  cost-panel           $0.010
Project · 7d          $12.34
 Today $0.5123 · saved $3.40
 7d ▁▂▄▅▆▇
10 ses · prices 38m · r17
```

- **Header** — the `OpencodeBar` brand renders bold (OpenTUI `<b>` span),
  followed by `· API est.` in the normal weight. The header's natural width
  (26 cells) can extend past the value column but stays inside the 34-column
  sidebar budget.
- **Session (API est.)** — family total, matched models only. Money values
  use adaptive precision: 2 decimals from $100, 3 from $1, 4 below.
- **↺ saved** — cache savings under the session row: what the cached tokens
  would have cost at the uncached input price (per-component clamp, so a
  cache tier priced above input never counts negative). Hidden when zero.
- One line per model, merged across the family, sorted by cost. Whenever the
  family total is positive and at least one model is priced, each line
  carries a 7-cell share zone — a 3-cell `▇` bar plus the model's integer
  percent of the family total (e.g. `▇▇  67%`). The common single-model
  session shows a full `▇▇▇100%` zone.
- Models without a LiteLLM price are listed with a `no price` marker.
  Prices are never guessed; they are excluded from totals.
- **Subagents (N)** — appears only when the family has subagent sessions,
  followed by the top 4 by cost (positive only), one right-aligned row per
  subagent titled with its session title (short session id as fallback).
- **Project (7d)** — matched-model cost of the project's sessions created in
  the last 7 days (capped at the 200 newest). The total spans the whole
  project — repo root and every git worktree — so working in a worktree still
  shows the full project history; recompute follows `worktree.updated` /
  `worktree.resolved` events. Value is `…` while loading, `!` when the fetch
  failed (with a `! <message>` warning line under it).
- **Today line** — under the project row (once the total is positive):
  today's spend, plus the 7-day window's cache savings when positive.
- **7d sparkline** — under the today line: one block per local calendar
  day, oldest (6 days ago) to today. Block height is the square root of
  the day's share of the week's max spend, so cheap days stay readable
  next to a spike; a zero-spend day renders a space.
- Footer — session count, price-cache age (`prices 38m`; the full
  diagnostic label is kept for loading/failure states), and the `r<N>`
  reactivity heartbeat. Every row stays inside the 34-column sidebar
  budget; messages are truncated with an ellipsis to fit.

### Diagnostics

- `! ctx: <message>` — the session transcript fetch failed and the report has
  no models and a zero total yet; cleared by a successful fetch.
- Project value `!` plus a `! <message>` line — the project-total fetch chain
  failed; shown until a successful recompute replaces it (`…` = loading).
- Footer `· r<N>` — reactivity heartbeat: N is the panel's internal revision
  and is bumped on usage events, session switches, and every 30s tick. If N
  stays frozen across ticks, the signal graph is dead — the panel will not
  update no matter what the plugin computes (for the known cause, see the
  dual-Solid note under [Publish notes](#publish-notes)).

## Commands

- `/opencodebar refresh` — force a price-table refresh regardless of cache age.

## Install

opencodebar is a TUI-only plugin: the sidebar cost panel runs in the TUI
client against the OpenCode server. There is no server entry — OpenCode
discovers the plugin by the filename `tui.ts`.

### Global (all projects) — symlink

```sh
ln -sfn /path/to/OpencodeBar/opencodebar ~/.config/opencode/plugins/opencodebar
```

Then restart the TUI in any project. Updates are live: `git pull` in the repo
and restart the TUI. Remove with `rm ~/.config/opencode/plugins/opencodebar`.

### Project-local

Copy or symlink the package into `<project>/.opencode/plugins/opencodebar/`.
On OpenCode 2.0.22 the server does not auto-discover project
`.opencode/plugins/`, but the TUI client does (verified: the sidebar panel
loads).

### From npm / Git (once distributed)

```sh
opencode plugin add opencodebar            # once published to npm
opencode plugin add github.com:<owner>/OpencodeBar
```

This requires the package `package.json` at the repo root (currently the
package lives in the `opencodebar/` subdirectory). See publish notes below.

### Publish notes

`npm publish` ships the prebuilt bundle (`dist/tui.js`, produced by
`npm run build`) — the host loads the package's `./tui` export for the CLI
plugin.

Peer dependencies (`@opentui/core`, `@opentui/solid`, `solid-js`) are marked
**optional** in `peerDependenciesMeta`, and they must stay optional: the
OpenCode host provides these modules at runtime by resolving bare imports to
its own internal copies when the plugin's install tree does not contain them.
If npm auto-installs them (any non-optional peer is auto-installed by npm 7+),
the managed install grows its own physical Solid copies. Two Solid instances
means two disconnected reactivity graphs: the panel renders its initial
zero state once and every async update (`session.usage.updated`, project
total, tick) bumps a signal the host renderer never observes — the panel
freezes at `$0.0000`. Verified empirically on OpenCode 2.0.22.

After publishing, `opencode plugin add opencodebar` installs it globally.

## How it works

- **Prices**: `model_prices_and_context_window.json` from LiteLLM's repo,
  trimmed to `input_cost_per_token`, `output_cost_per_token`,
  `cache_read_input_token_cost`, `cache_creation_input_token_cost`
  (USD per single token; missing tiers count as 0 and are flagged unknown).
  Stored in durable plugin storage under `prices`, refreshed at
  most once per 24h with a 10s timeout; on failure the stale table is kept
  and its age is surfaced in the footer.
- **Model matching** (deterministic, first hit wins): exact
  `providerID/modelID`, alias prefixes (`google` tries `gemini/` then
  `google/`), dash-prefix cascade for coding-plan providers
  (`zai-coding-plan` → `zai/glm-5.3`), the bare model id, then a suffix
  fallback that matches the model id against the final segment of LiteLLM
  keys and prefers a first-party vendor key (e.g. `mimo-v2.6-pro` →
  `xiaomi_mimo/mimo-v2.6-pro`, not `openrouter/xiaomi/...`). Ambiguous
  non-vendor keys stay unmatched. `variant` is ignored. No fuzzy matching —
  unknown models are reported, never priced.
- **Formula**: `input*input + (output+reasoning)*output + cache.read*cacheRead
  + cache.write*cacheWrite` (per-token prices). Cache savings (session and
  project `saved` values) are `cache.read*(input-cacheRead) +
  cache.write*(input-cacheWrite)`, clamped per component at 0.
- **Project total**: prefers the server's one-call `session.stats` (per-model
  token usage for the window); falls back to paginating `/api/session`
  newest-first and reading messages with concurrency 4. Cached 60s,
  invalidated on usage events.
- **Reactivity**: recomputes on `session.usage.updated` events, on session
  selection changes, and on a 30s tick.

### Reasoning-token validation

Validated empirically on 2026-10-04 against OpenCode's built-in per-message
cost for session `ses_efbd93c2cffeNcIuIX2tQPpVrO`
(`opencode-go/mimo-v2.6-pro`, matching LiteLLM `xiaomi_mimo/mimo-v2.6-pro`:
$4.35e-7 in / $8.7e-7 out / $3.6e-9 cache-read):

| Formula                      | Computed     | Built-in    | Delta   |
| ---------------------------- | -----------  | ----------- | ------- |
| reasoning billed as output   | $0.039131067 | $0.039135355 | 0.011%  |
| reasoning excluded           | $0.017723847 | $0.039135355 | 55% low |

Per-message deltas for the "billed as output" variant were ~0.008%. OpenCode's
`tokens.output` and `tokens.reasoning` are disjoint counters, so reasoning is
billed at the output rate by default (`includeReasoning: false` in
`src/cost.ts` disables it).

## Development

```sh
npm install
npm test          # vitest run (pure modules: pricing, cost)
npm run typecheck # tsc --noEmit (includes the TUI layer)
```

`src/pricing.ts` and `src/cost.ts` are dependency-free and fully unit-tested
(RED -> GREEN). The TUI layer (`src/tui.tsx`, `src/ui.tsx`) has no
deterministic runnable harness — a documented exception; it is verified by
typecheck plus a plugin load check.

## Limitations

- Sessions on coding-plan providers show `$0` built-in cost by design; this
  plugin computes from tokens, so it works where the built-in number does not.
- Auxiliary generation (titles, compaction) is only counted where it surfaces
  as assistant messages in the transcript; usage-only events update the
  project aggregate but not per-model session lines.
- Prices are list prices: discounts, batch rates, and provider-specific deals
  are not reflected.
