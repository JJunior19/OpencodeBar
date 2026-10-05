# Feature: TUI observability + style polish (diagnose frozen panel)

## Objective

Make the Cost panel diagnosable and slightly nicer: surface real errors
instead of an eternal `…`, add a reactivity heartbeat, adaptive USD
precision, and share percentages — so the next freeze shows its cause
on screen.

## Problem / Why

The panel froze at its initial render (Session $0.0000, Project `…`)
in a fresh worktree. External causes were ruled out with evidence
(2026-10-05): session data exists in `opencode.db` (`session_v2`,
project `cc3412fb`), all plugin API calls verified working via curl
against `/api/session` + `/api/worktree`, and the npm-managed 0.1.2
install contains both prior fixes (optional peers, worktree spanning).
The failure is in-process and invisible because every async path
swallows errors (`.catch(() => {})`) and no error state exists in the
panel views.

## Scope

- Error states: `ProjectTotalView` gains `state: "error"` + message;
  family-usage fetch errors surface as a `! ctx: <msg>` line.
- Reactivity heartbeat: footer shows `r<N>` from the panel revision.
- Adaptive USD precision for session/model/subagent rows.
- Share bar: proportional-to-total bar (3 cells) + `NN%` label.
- README (plugin) layout contract + features updated.
- Build `dist/tui.js`; install vehicle = config-dir symlink to this
  worktree (documented dev flow) so the user can reproduce with the
  instrumented build.

Out of scope (follow-ups): Today line, 7d sparkline, budget command,
cache-saved line, subagent breakdown.

## Constraints / decisions

- Hard sidebar budget ~34 columns; rows must not overflow.
- Presentation stays in `src/ui.tsx` (no OpenCode imports); string
  builders stay in `src/format.ts` (JSX-free, unit-tested).
- `src/tui.tsx` owns OpenCode interaction and error capture.
- Do not change pricing/matching semantics (`pricing.ts` untouched).
- `package.json`, `tui.ts`, `dist/` (gitignored build output) untouched.
- TDD: pure builders in `format.ts` go RED → GREEN under vitest.
- Baseline before changes: `npm test` green (30/30 as of last doc).

## Delivery strategy

ask-on-risk; forecast ~270 authored lines — single work-unit commit
pair (observability; style) on `feature/tui-improve`, no PR yet.

## Tasks

- [x] T1 — Observability: error states + heartbeat. Commit `beaab35`.
  - `ProjectTotalView` += `"error"` state + `message`.
  - `ensureProjectTotal` records last project error (cleared on
    success only); `projectTotal()` returns error state when no cache
    and an error message exists (error wins over loading).
  - `scheduleUsages`/`fetchUsages` errors recorded (last family
    error, reset on session switch); `PanelController.errors()`
    exposes both messages.
  - Panel: project row value `!` + truncated message line (warning
    color) on error; `! ctx: <msg>` line when family errored and the
    report is empty; footer gains `· r<N>`.
  - Route: delegated writer (gentle-ai-worker, foreground).
- [x] T2 — Style: adaptive precision + share percent. Commit `beaab35`.
  - `formatUSDAdaptive(usd)`: >=100 → 2dp, >=1 → 3dp, else 4dp, on
    session/model/subagent rows; Project 7d keeps 2dp.
  - `shareBar(usd, totalUsd, contenders)`: 7-cell zone = 3-cell bar
    proportional to family TOTAL + right-aligned `NN%` (100% borrows
    the gap cell); empty when contenders < 2 or total <= 0.
    `NAME_MAX` 16 → 14; budget guard test locks rows <= 34 cols.
  - Extra builders (test-covered): `truncateWithEllipsis`,
    `heartbeatFooter` (trims body, never the heartbeat).
  - Route: delegated writer. RED (10 failed) → GREEN (63 passed),
    second RED→GREEN cycle for heartbeatFooter.
- [x] T3 — Build + install vehicle + docs. Commit `beaab35` (build,
  README); install vehicle executed by parent 2026-10-05 02:46:
  `opencode plugin remove opencodebar` (dropped managed 0.1.2) +
  symlink `~/.config/opencode/plugins/opencodebar` → this worktree's
  `opencodebar/`. TUI restart pending (user action).

- [x] T4 — Style pass 2 + weekly timeline. Commit `866b96e`.
  - `fitLabel`: truncates only when label LONGER than width
    (`Project · 7d` exact-12 no longer renders `Project · 7…`).
  - `shareBar`: draws when contenders >= 1 && total > 0; single model
    renders `▇▇▇100%`; multi-model relative shares unchanged.
  - Header brand: per-span bold `OpencodeBar · API est.` via OpenTUI
    `<b>` (BoldSpanRenderable — verified in @opentui/solid types AND
    host 2.0.22 binary by writer); split lives in tested
    `sectionHeaderParts`; bold span inherits parent fg (no span fg).
  - Weekly timeline: `sparklineBlocks` (7 cells, ramp `▁▂▃▄▅▆▇`,
    0 → space); `computeProjectTotal` buckets session cost by LOCAL
    calendar day (slot 0 = 6 days ago, DST-safe `localDaysAgo`,
    rolling-window edge guarded 0..6); `ProjectTotalView.days`;
    muted `7d <blocks>` row under Project · 7d when ok && total > 0.
  - Route: delegated writer. RED 9 failed → GREEN 28/28 file scope;
    63 → 72 total. Typecheck clean, build 29.59 KB.
- [ ] T5 — Readability + cache savings + subagent breakdown
  (user-selected 2026-10-05; budget + theme-reactivity stay follow-ups).
  - Legibility: (1) `Today` value on the project block from `days[6]`,
    rendered as muted `Today $X · saved $Y` under `Project · 7d`
    (saved part omitted when <= 0; line shown when ok && total > 0).
    (2) `sparklineBlocks` level formula sqrt-scaled:
    `round(sqrt(v/max) * 6)` — small days stop vanishing. (3) Compact
    footer: `N ses · prices <compactAge>` (new `compactAge`: now/38m/
    2h/1d); warning/unavailable footer keeps full label (diagnosis
    beats brevity). `PriceStatusView` += `ageMs` so the UI can compact.
  - Cache savings: additive `computeTokenSavings(tokens, entry)` in
    cost.ts (saved = cr*(input-cr_price) + cw*(input-cw_price),
    clamped >= 0, 0 for unmatched); wired into rollupFamily
    (`FamilyReport.cacheSaved`) and the project scan
    (`ProjectTotalView.saved`). Display: session `↺ saved $X` muted
    line after token detail; project in the Today line.
  - Subagent breakdown: `FamilyReport.subagents.items`
    ({sessionID, usd}[] desc, pure/tested) + additive pure
    `withSubagentNames(report, resolve)` injecting names; tui resolves
    via `context.data.session.get(id)?.title ?? ""`; UI shows top 4
    named items under the aggregate line (fitLabel 14, adaptive USD).
  - CONSTRAINT AMENDMENT: cost.ts unlocked ADDITIVE-only (new exports
    + subagents.items field; existing export semantics frozen).
  - Route: delegated writer. TDD on all pure additions.
- [x] T5 — SHIPPED. Commit `14b5901`. RED 15 failed → GREEN 85/85;
  typecheck clean; build 32.94 KB. Parent spot check 85/85 + readback
  (clamp math, items sort, additive-only verified). Writer decisions:
  half-max renders ramp[4] (▅) per formula; footer loading keeps full
  label (ageMs=0 would lie "now"); todayLine self-trims (worst case 35
  cells); zero-usd subagent items kept for count invariant, filtered
  in render. Pending: user live look.

## Verification of record

- Baseline (writer, pre-change): `npm test` → 52 passed (3 files).
- RED evidence: rewritten builder tests → 10 failed | 51 passed;
  heartbeatFooter cycle → 2 failed; then implementation.
- Final (writer): `npm test` → 63 passed (3 files); `npm run
  typecheck` → clean; `npm run build` → dist/tui.js 27.43 KB.
- Parent spot check: `npm test` → 63 passed (02:45).
- Assess (RDD off, tier medium: executable_change dist/tui.js,
  420 changed lines): writer self-verification + parent structural
  readback of tui.tsx/ui.tsx hunks (error precedence, errors() memo
  reading revision(), family-error guard) — approved.
- Live TUI verification: PENDING (user restarts TUI; watch r<N>
  advancing and any `!` lines).

## Progress log

- 2026-10-05: investigation concluded (see Problem / Why); feature doc
  created; branch `feature/tui-improve`; RDD off (global).
- 2026-10-05 02:43: writer completed T1+T2+T3-build; all checks green.
- 2026-10-05 02:46: work-unit commit `beaab35`; install vehicle
  swapped (managed 0.1.2 → symlink to this worktree).
- 2026-10-05 03:07: T4 committed `866b96e` (parent spot check: 72/72,
  diff readback: bucketing slot guard, header parts, sparkline guard
  all correct). Pending: user restarts TUI to see bold header,
  single-model bar and 7d sparkline.
- 2026-10-05 03:47: T5 committed `14b5901` (Today + savings + subagent
  breakdown + sqrt sparkline + compact footer). Follow-ups kept open:
  budget command, theme reactivity, managed-loader root cause, daily
  burn attribution by message time.

## Delivery record

- PR #7 `feat/tui-improve` → `main`, single slice holding commits
  `beaab35`, `2b3476f`, `866b96e`, `b810ca1`, `14b5901`, `96ad8cd`.
  Links approved issue #6 (`status:approved`), label `type:feature`.
  Branch renamed `feature/tui-improve` → `feat/tui-improve` before
  first push (branch-pr naming rule).

## Next step

User restarts the TUI and reads the panel: if `r<N>` advances but
`!`/`! ctx:` lines appear, send me the message text (that is the
previously-invisible error). If `r<N>` is frozen, the Solid signal
graph is dead in the config-dir load path — next investigation step
is the host plugin loader.

- 2026-10-05 02:55: USER LIVE RESULT (symlink install): panel ALIVE —
  Project $22.64, 9 sessions, r23 advancing. Frozen-panel mystery
  resolved: managed npm install path was the culprit; config-dir
  symlink load works. User feedback for next pass: (1) `Project · 7…`
  truncation ugly (fitLabel exact-length bug), (2) wants weekly
  timeline bars, (3) wants brand title bold. -> T4 created.
