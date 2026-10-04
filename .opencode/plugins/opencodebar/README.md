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
Session (API est.): $0.1234
  claude-sonnet-4-5   $0.1100
  gpt-5-mini          $0.0134
  internal-model      no price (12.3k tok)
Subagents (2): $0.0500
Project (7d): $12.34
prices: 2h old
```

- **Session (API est.)** — family total, matched models only.
- One line per model, merged across the family, sorted by cost.
- Models without a LiteLLM price are listed with token counts and a
  `no price` marker. Prices are never guessed; they are excluded from totals.
- **Subagents (N)** — appears only when the family has subagent sessions.
- **Project (7d)** — matched-model cost of the project's sessions created in
  the last 7 days (capped at the 200 newest).
- Footer — price cache age, or a fetch failure notice (stale prices are kept).

## Commands

- `/opencodebar refresh` — force a price-table refresh regardless of cache age.

## Install

> **Verified against OpenCode 2.0.22:** project-local `.opencode/plugins/`
> directories are **not** auto-discovered by the server in this build
> (tested: file form `plugins/<name>/index.ts`, package form with
> `package.json` exports, and `plugins` entries in `opencode.jsonc` with
> relative and absolute paths). The server discovers plugins only from
> builtins, `~/.config/opencode/plugins/*.ts` files, and npm/Git packages
> installed with `opencode plugin add`. The layout below is kept so the
> package activates automatically once project-local discovery ships.

### From npm / Git (recommended)

```sh
opencode plugin add opencodebar        # once published to npm
# or, from a Git remote:
opencode plugin add github.com:<owner>/OpencodeBar
```

This installs the package into OpenCode's managed plugin cache and registers
it in the global configuration. The server plugin (`.` export) loads in the
server; the CLI plugin (`./tui` export) loads in the TUI client. Restart the
TUI after installing.

### In a repository (future auto-load)

Keep the package at `.opencode/plugins/opencodebar/`. Per the v2 docs,
plugins under `.opencode/plugins/` load automatically — on 2.0.22 this did
not work empirically; re-test after upgrading.

### Verified local-server check

With a symlink `~/.config/opencode/plugins/opencodebar-server.ts` pointing
at `src/index.ts`, a fresh `opencode serve` reports:

```
opencodebar.server | local | { server: true } | { status: "active" }
```

The `./tui` entry requires the TUI client host (sidebar slots, storage,
theme) and cannot load inside a bare server process — by design.

### Publish notes

`npm publish` ships the package as-is (TypeScript sources, per OpenCode plugin
convention — the host loads `.` for the server plugin and `./tui` for the CLI
plugin). Peer dependencies (`@opentui/core`, `@opentui/solid`, `solid-js`)
are provided by the OpenCode host at runtime. After publishing,
`opencode plugin add opencodebar` installs it globally.

## How it works

- **Prices**: `model_prices_and_context_window.json` from LiteLLM's repo,
  trimmed to `input_cost_per_token`, `output_cost_per_token`,
  `cache_read_input_token_cost`, `cache_creation_input_token_cost`
  (USD per single token; missing tiers count as 0 and are flagged unknown).
  Stored in durable plugin storage under `prices`, refreshed at
  most once per 24h with a 10s timeout; on failure the stale table is kept
  and its age is surfaced in the footer.
- **Model matching** (deterministic, first hit wins): exact
  `providerID/modelID`, then alias prefixes (`google` tries `gemini/` then
  `google/`), then the bare model id. `variant` is ignored. No fuzzy
  matching — unknown models are reported, never priced.
- **Formula**: `input*input + (output+reasoning)*output + cache.read*cacheRead
  + cache.write*cacheWrite` (per-token prices).
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
