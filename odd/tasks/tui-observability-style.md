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

## Next step

User restarts the TUI and reads the panel: if `r<N>` advances but
`!`/`! ctx:` lines appear, send me the message text (that is the
previously-invisible error). If `r<N>` is frozen, the Solid signal
graph is dead in the config-dir load path — next investigation step
is the host plugin loader.
