# OpencodeBar

An [OpenCode v2](https://opencode.ai) TUI plugin that shows the **API-equivalent
cost** of your sessions in the sidebar, priced from
[LiteLLM](https://github.com/BerriAI/litellm) list prices.

Coding plans (Claude Max, ChatGPT Plus, Cursor, …) hide the real API cost.
OpencodeBar recomputes it from raw token usage × LiteLLM list prices, so you
always see what a session *would have cost* through the API — per model, per
subagent, and per project.

## Features

- **Per-model breakdown** in the sidebar, including model switches mid-session.
- **Subagent sessions** rolled into the parent, each with their own model lines.
- **Session total** + **project total for the last 7 days**.
- Prices from LiteLLM, refreshed once per day (stale cache kept on fetch failure).
- Models without a LiteLLM price are shown honestly as `no price` — never guessed.

## Install (global — all projects)

### Via symlink (current)

```sh
git clone https://github.com/JJunior19/OpencodeBar.git ~/OpencodeBar
ln -sfn ~/OpencodeBar/opencodebar ~/.config/opencode/plugins/opencodebar
```

Restart the TUI. The sidebar shows a `Cost · API est.` panel in every project.
Live-updates on `git pull` + TUI restart.

### Via `opencode plugin add` (npm / Git)

The plugin currently ships raw `.tsx` (JSX). OpenCode's Solid JSX transform
skips files under `node_modules/` (the managed plugin cache), so a package
install falls back to the React runtime and fails to load. Once the plugin is
pre-built to JavaScript (`.tsx` → `.js`), it installs with:

```sh
opencode plugin add opencodebar                                       # once published to npm
opencode plugin add 'github:JJunior19/OpencodeBar#feat/cost-tracker-plugin::path:opencodebar'
```

> **Note:** OpenCode plugins do **not** install with `npm install -g` or
> `pnpm add -g`. Use `opencode plugin add`, which accepts npm packages and Git
> specs (including `::path:` subdirectory selectors).

## Update

```sh
cd ~/OpencodeBar && git pull   # then restart the TUI
```

## Uninstall

```sh
rm ~/.config/opencode/plugins/opencodebar
```

## How it works

- **Prices** come from LiteLLM's `model_prices_and_context_window.json`, cached
  in durable plugin storage with a 24h refresh and a 10s fetch timeout.
- **Cost** = tokens × per-token list prices: `input`, `output` (+ `reasoning`,
  billed as output), `cache read`, `cache write`.
- **Matching** is deterministic: exact `provider/model` → provider aliases →
  coding-plan dash-prefix (`zai-coding-plan` → `zai`) → bare id → suffix match
  preferring the first-party vendor key. Unknown models are reported, never
  priced.

See [opencodebar/README.md](opencodebar/README.md) for the full reference:
matching rules, the cost formula, reasoning-token validation, and development
notes.
