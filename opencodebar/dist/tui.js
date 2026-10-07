// src/tui.tsx
import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";

// src/cost.ts
function computeTokenCost(tokens, entry, options = {}) {
  if (entry === undefined)
    return 0;
  const output = options.includeReasoning === false ? tokens.output : tokens.output + tokens.reasoning;
  return tokens.input * entry.input + output * entry.output + tokens.cache.read * entry.cacheRead + tokens.cache.write * entry.cacheWrite;
}
function computeTokenSavings(tokens, entry) {
  if (entry === undefined)
    return 0;
  const readSaving = tokens.cache.read * (entry.input - entry.cacheRead);
  const writeSaving = tokens.cache.write * (entry.input - entry.cacheWrite);
  return Math.max(0, readSaving) + Math.max(0, writeSaving);
}
function emptyUsage() {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}
function addUsage(target, source) {
  return {
    input: target.input + source.input,
    output: target.output + source.output,
    reasoning: target.reasoning + source.reasoning,
    cache: {
      read: target.cache.read + source.cache.read,
      write: target.cache.write + source.cache.write
    }
  };
}
function aggregateModels(usages, lookup) {
  const rows = new Map;
  for (const usage of usages) {
    const key = `${usage.model.providerID}/${usage.model.id}`;
    const entry = lookup(usage.model.providerID, usage.model.id);
    const current = rows.get(key) ?? {
      key,
      providerID: usage.model.providerID,
      modelID: usage.model.id,
      tokens: emptyUsage(),
      usd: 0,
      matched: entry !== undefined
    };
    const tokens = addUsage(current.tokens, usage.tokens);
    rows.set(key, { ...current, tokens, usd: current.usd + computeTokenCost(usage.tokens, entry) });
  }
  return [...rows.values()].sort((a, b) => {
    if (a.matched !== b.matched)
      return a.matched ? -1 : 1;
    if (a.matched && b.matched && a.usd !== b.usd)
      return b.usd - a.usd;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}
function withSubagentNames(report, resolve) {
  return {
    ...report,
    subagents: {
      ...report.subagents,
      items: report.subagents.items.map((item) => ({ ...item, name: resolve(item.sessionID) }))
    }
  };
}
function rollupFamily(sessions, rootID, lookup) {
  let total = 0;
  let cacheSaved = 0;
  let subagentCount = 0;
  let subagentTotal = 0;
  let tokens = emptyUsage();
  const all = [];
  const subagentItems = [];
  for (const session of sessions) {
    let sessionTotal = 0;
    for (const usage of session.usages) {
      all.push(usage);
      tokens = addUsage(tokens, usage.tokens);
      const entry = lookup(usage.model.providerID, usage.model.id);
      sessionTotal += computeTokenCost(usage.tokens, entry);
      cacheSaved += computeTokenSavings(usage.tokens, entry);
    }
    total += sessionTotal;
    if (session.sessionID !== rootID) {
      subagentCount++;
      subagentTotal += sessionTotal;
      subagentItems.push({ sessionID: session.sessionID, usd: sessionTotal });
    }
  }
  subagentItems.sort((a, b) => b.usd - a.usd);
  const models = aggregateModels(all, lookup);
  return {
    total,
    models,
    tokens,
    subagents: { count: subagentCount, total: subagentTotal, items: subagentItems },
    cacheSaved,
    unmatchedModels: models.filter((row) => !row.matched).length
  };
}
var PROJECT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
var PROJECT_SESSION_CAP = 200;
function resolveProjectDirectories(worktreeDirectories, sessionDirectory) {
  const directories = [];
  const seen = new Set;
  for (const directory of [...worktreeDirectories, sessionDirectory]) {
    if (directory === "" || seen.has(directory))
      continue;
    seen.add(directory);
    directories.push(directory);
  }
  return directories;
}
function isInProjectWindow(createdMs, nowMs, windowMs = PROJECT_WINDOW_MS) {
  return Number.isFinite(createdMs) && createdMs >= nowMs - windowMs;
}
function shouldStopProjectPagination(createdMs, nowMs, sessionsSeen, windowMs = PROJECT_WINDOW_MS, cap = PROJECT_SESSION_CAP) {
  if (sessionsSeen >= cap)
    return true;
  if (createdMs === undefined || !Number.isFinite(createdMs))
    return true;
  return createdMs < nowMs - windowMs;
}
function formatUSD(amount, decimals) {
  return `$${amount.toFixed(decimals)}`;
}
function trim(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}
function formatTokens(count) {
  const n = Math.max(0, count);
  if (n < 999.5)
    return String(Math.round(n));
  if (n < 999500)
    return `${trim(n / 1000)}k`;
  if (n < 999500000)
    return `${trim(n / 1e6)}M`;
  return `${trim(n / 1e9)}G`;
}
function formatAge(ageMs) {
  const ms = Math.max(0, ageMs);
  if (ms < 60000)
    return "just now";
  if (ms < 60 * 60000)
    return `${Math.floor(ms / 60000)}m old`;
  if (ms < 24 * 60 * 60000)
    return `${Math.floor(ms / (60 * 60000))}h old`;
  return `${Math.floor(ms / (24 * 60 * 60000))}d old`;
}

// src/pricing.ts
var PROVIDER_ALIASES = {
  google: ["gemini", "google"],
  azure: ["azure"]
};
var VENDOR_PREFIXES = new Set([
  "anthropic",
  "openai",
  "google",
  "gemini",
  "deepseek",
  "zai",
  "xiaomi_mimo",
  "mistral",
  "cohere",
  "xai",
  "groq"
]);
function readCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseLiteLLMPrices(json) {
  if (!isRecord(json))
    return {};
  const table = {};
  for (const [key, raw] of Object.entries(json)) {
    if (!isRecord(raw))
      continue;
    const input = readCost(raw.input_cost_per_token);
    const output = readCost(raw.output_cost_per_token);
    const cacheRead = readCost(raw.cache_read_input_token_cost);
    const cacheWrite = readCost(raw.cache_creation_input_token_cost);
    if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
      continue;
    }
    table[key] = {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: cacheRead ?? 0,
      cacheWrite: cacheWrite ?? 0,
      known: {
        input: input !== undefined,
        output: output !== undefined,
        cacheRead: cacheRead !== undefined,
        cacheWrite: cacheWrite !== undefined
      },
      litellmKey: key
    };
  }
  return table;
}
function get(table, key) {
  const entry = table[key];
  return entry === undefined || typeof entry.litellmKey !== "string" ? undefined : entry;
}
var suffixIndexCache = new WeakMap;
function suffixIndex(table) {
  const cached = suffixIndexCache.get(table);
  if (cached !== undefined)
    return cached;
  const index = new Map;
  for (const key of Object.keys(table)) {
    const slash = key.lastIndexOf("/");
    if (slash <= 0 || slash === key.length - 1)
      continue;
    const modelID = key.slice(slash + 1);
    const existing = index.get(modelID);
    if (existing === undefined)
      index.set(modelID, [key]);
    else
      existing.push(key);
  }
  suffixIndexCache.set(table, index);
  return index;
}
function suffixMatch(table, modelID) {
  const candidates = suffixIndex(table).get(modelID);
  if (candidates === undefined || candidates.length === 0)
    return;
  for (const key of candidates) {
    const prefix = key.slice(0, key.length - modelID.length - 1);
    if (VENDOR_PREFIXES.has(prefix))
      return get(table, key);
  }
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only !== undefined)
      return get(table, only);
  }
  return;
}
function lookupPrice(table, providerID, modelID) {
  const prefixed = get(table, `${providerID}/${modelID}`);
  if (prefixed !== undefined)
    return { matched: true, entry: prefixed };
  const aliases = PROVIDER_ALIASES[providerID];
  if (aliases !== undefined) {
    for (const prefix of aliases) {
      const entry = get(table, `${prefix}/${modelID}`);
      if (entry !== undefined)
        return { matched: true, entry };
    }
  }
  const segments = providerID.split("-");
  for (let end = segments.length - 1;end >= 1; end--) {
    const prefix = segments.slice(0, end).join("-");
    const entry = get(table, `${prefix}/${modelID}`);
    if (entry !== undefined)
      return { matched: true, entry };
  }
  const bare = get(table, modelID);
  if (bare !== undefined)
    return { matched: true, entry: bare };
  const suffix = suffixMatch(table, modelID);
  if (suffix !== undefined)
    return { matched: true, entry: suffix };
  return { matched: false };
}

// src/ui.tsx
import { For, Show, createMemo } from "solid-js";

// src/format.ts
var PANEL_WIDTH = 34;
var VALUE_WIDTH = 10;
var SHARE_ZONE_WIDTH = 7;
var SHARE_BAR_CELLS = 3;
var NAME_MIN = 8;
var NAME_MAX = 14;
var DETENT = 2;
function fitLabel(label, width) {
  if (label.length > width)
    return label.slice(0, Math.max(0, width - 1)) + "…";
  return label.padEnd(width);
}
function panelRow(label, value, labelWidth) {
  return fitLabel(label, labelWidth) + value.padStart(VALUE_WIDTH);
}
function valueEdge(nameWidth) {
  return DETENT + nameWidth + 1 + SHARE_ZONE_WIDTH + VALUE_WIDTH;
}
function labelWidthToEdge(edge, indent) {
  return Math.max(1, edge - indent - VALUE_WIDTH);
}
function sectionHeader(title, width) {
  const text = ` ${title} `;
  const right = Math.max(0, width - text.length - 2);
  return "──" + text + "─".repeat(right);
}
var HEADER_BRAND = "OpencodeBar";
var HEADER_TITLE = `${HEADER_BRAND} · API est.`;
function sectionHeaderParts(width) {
  const full = sectionHeader(HEADER_TITLE, width);
  const lead = full.slice(0, full.indexOf(HEADER_BRAND));
  const tail = full.slice(lead.length + HEADER_BRAND.length);
  return [lead, HEADER_BRAND, tail];
}
function truncateWithEllipsis(text, width) {
  if (text.length <= width)
    return text;
  return text.slice(0, Math.max(0, width - 1)) + "…";
}
function shareBar(usd, totalUsd, contenders) {
  if (contenders < 1 || totalUsd <= 0)
    return "";
  const share = usd / totalUsd;
  const filled = Math.max(1, Math.round(share * SHARE_BAR_CELLS));
  const percent = Math.round(share * 100);
  return "▇".repeat(Math.min(SHARE_BAR_CELLS, filled)).padEnd(SHARE_BAR_CELLS) + `${percent}%`.padStart(SHARE_ZONE_WIDTH - SHARE_BAR_CELLS);
}
var SPARK_RAMP = "▁▂▃▄▅▆▇";
function sparklineBlocks(days) {
  if (days.length === 0)
    return "";
  const max = days.reduce((highest, value) => Math.max(highest, value), 0);
  if (max <= 0)
    return " ".repeat(days.length);
  return days.map((value) => value <= 0 ? " " : SPARK_RAMP[Math.round(Math.sqrt(value / max) * (SPARK_RAMP.length - 1))]).join("");
}
function formatUSDAdaptive(amount) {
  if (amount >= 100)
    return formatUSD(amount, 2);
  if (amount >= 1)
    return formatUSD(amount, 3);
  return formatUSD(amount, 4);
}
function todayLine(todayUsd, savedUsd) {
  const head = ` Today ${formatUSDAdaptive(todayUsd)}`;
  if (savedUsd <= 0)
    return head;
  return truncateWithEllipsis(`${head} · saved ${formatUSDAdaptive(savedUsd)}`, PANEL_WIDTH);
}
function billedOutput(tokens) {
  return tokens.output + tokens.reasoning;
}
function tokenDetail(tokens) {
  const cache = tokens.cache.read + tokens.cache.write;
  return `↓ ${formatTokens(tokens.input)} · ↑ ${formatTokens(billedOutput(tokens))} · ↺ ${formatTokens(cache)}`;
}

// src/ui.tsx
import { jsxDEV } from "@opentui/solid/jsx-dev-runtime";
function shortModelName(modelID) {
  const slash = modelID.lastIndexOf("/");
  return slash === -1 ? modelID : modelID.slice(slash + 1);
}
function shortSessionID(sessionID) {
  const bare = sessionID.startsWith("ses_") ? sessionID.slice(4) : sessionID;
  return bare.slice(0, 8);
}
function CostPanel(props) {
  const report = createMemo(() => {
    props.sessionID;
    props.ctrl.revision();
    return props.ctrl.sessionReport(props.sessionID);
  });
  const project = createMemo(() => {
    props.sessionID;
    props.ctrl.revision();
    return props.ctrl.projectTotal(props.sessionID);
  });
  const prices = createMemo(() => props.ctrl.priceStatus());
  const errors = createMemo(() => {
    props.ctrl.revision();
    return props.ctrl.errors();
  });
  const nameWidth = createMemo(() => {
    const longest = report().models.reduce((max, model) => Math.max(max, shortModelName(model.modelID).length), 0);
    return Math.min(NAME_MAX, Math.max(NAME_MIN, longest));
  });
  const edge = createMemo(() => valueEdge(nameWidth()));
  const headerParts = createMemo(() => sectionHeaderParts(edge()));
  const barContenders = createMemo(() => report().models.filter((model) => model.matched && model.usd > 0).length);
  return /* @__PURE__ */ jsxDEV(Show, {
    when: props.sessionID !== "",
    children: /* @__PURE__ */ jsxDEV("box", {
      children: [
        /* @__PURE__ */ jsxDEV("text", {
          fg: props.theme.text,
          children: [
            headerParts()[0],
            /* @__PURE__ */ jsxDEV("b", {
              children: headerParts()[1]
            }, undefined, false, undefined, this),
            headerParts()[2]
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ jsxDEV("text", {
          fg: props.theme.text,
          children: panelRow("Session", formatUSDAdaptive(report().total), labelWidthToEdge(edge(), 0))
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV("text", {
          fg: props.theme.muted,
          children: `${" ".repeat(DETENT + 1)}${tokenDetail(report().tokens)}`
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV(Show, {
          when: report().cacheSaved > 0,
          children: /* @__PURE__ */ jsxDEV("text", {
            fg: props.theme.muted,
            children: `${" ".repeat(DETENT + 1)}↺ saved ${formatUSDAdaptive(report().cacheSaved)}`
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV(Show, {
          when: errors().family !== "" && report().models.length === 0 && report().total === 0,
          children: /* @__PURE__ */ jsxDEV("text", {
            fg: props.theme.warning,
            children: truncateWithEllipsis(`! ctx: ${errors().family}`, PANEL_WIDTH)
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV(For, {
          each: report().models,
          children: (model) => {
            const name = shortModelName(model.modelID);
            const bar = shareBar(model.usd, report().total, barContenders()).padEnd(SHARE_ZONE_WIDTH);
            return /* @__PURE__ */ jsxDEV("box", {
              children: [
                /* @__PURE__ */ jsxDEV(Show, {
                  when: model.matched,
                  fallback: /* @__PURE__ */ jsxDEV("text", {
                    fg: props.theme.warning,
                    children: `${" ".repeat(DETENT)}${fitLabel(name, nameWidth())} ${bar}${"no price".padStart(VALUE_WIDTH)}`
                  }, undefined, false, undefined, this),
                  children: /* @__PURE__ */ jsxDEV("text", {
                    fg: props.theme.muted,
                    children: `${" ".repeat(DETENT)}${fitLabel(name, nameWidth())} ${bar}${formatUSDAdaptive(model.usd).padStart(VALUE_WIDTH)}`
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV("text", {
                  fg: props.theme.muted,
                  children: `${" ".repeat(DETENT + 1)}${tokenDetail(model.tokens)}`
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this);
          }
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV(Show, {
          when: report().subagents.count > 0,
          children: /* @__PURE__ */ jsxDEV("box", {
            children: [
              /* @__PURE__ */ jsxDEV("text", {
                fg: props.theme.muted,
                children: panelRow(`· subagents (${report().subagents.count}):`, formatUSDAdaptive(report().subagents.total), labelWidthToEdge(edge(), DETENT))
              }, undefined, false, undefined, this),
              /* @__PURE__ */ jsxDEV(For, {
                each: report().subagents.items.filter((item) => item.usd > 0).slice(0, 4),
                children: (item) => /* @__PURE__ */ jsxDEV("text", {
                  fg: props.theme.muted,
                  children: `${" ".repeat(DETENT + 1)}${panelRow(item.name !== "" ? item.name : shortSessionID(item.sessionID), formatUSDAdaptive(item.usd), labelWidthToEdge(edge(), DETENT + 1))}`
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV("text", {
          fg: props.theme.text,
          children: panelRow("Project · 7d", project().state === "ok" ? formatUSD(project().total, 2) : project().state === "error" ? "!" : "…", labelWidthToEdge(edge(), 0))
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV(Show, {
          when: project().state === "ok" && project().total > 0,
          children: /* @__PURE__ */ jsxDEV("box", {
            children: [
              /* @__PURE__ */ jsxDEV("text", {
                fg: props.theme.muted,
                children: todayLine(project().days[6] ?? 0, project().saved)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ jsxDEV("text", {
                fg: props.theme.muted,
                children: `7d ${sparklineBlocks(project().days)}`
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV(Show, {
          when: project().state === "error",
          children: /* @__PURE__ */ jsxDEV("text", {
            fg: props.theme.warning,
            children: truncateWithEllipsis(`! ${project().message}`, PANEL_WIDTH)
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV(Show, {
          when: prices().state === "error" || prices().state === "unavailable",
          fallback: /* @__PURE__ */ jsxDEV("text", {
            fg: props.theme.muted,
            children: prices().state === "loading" ? prices().label : `${project().state === "ok" ? project().sessionCount : 0} sessions total`
          }, undefined, false, undefined, this),
          children: /* @__PURE__ */ jsxDEV("text", {
            fg: props.theme.warning,
            children: prices().label
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this)
  }, undefined, false, undefined, this);
}

// src/tui.tsx
import { jsxDEV as jsxDEV2 } from "@opentui/solid/jsx-dev-runtime";
var LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
var PRICE_REFRESH_MS = 24 * 60 * 60 * 1000;
var FETCH_TIMEOUT_MS = 1e4;
var PROJECT_TTL_MS = 60000;
var PANEL_TICK_MS = 30000;
var FAMILY_REFRESH_MS = 5000;
var PROJECT_PAGE_LIMIT = 50;
var PROJECT_FETCH_CONCURRENCY = 4;
var tui_default = Plugin.define({
  id: "opencodebar",
  setup(context) {
    const [prices, updatePrices] = context.storage.store("prices", {
      initial: { fetchedAt: 0, entries: {}, error: "" }
    });
    let priceFetch;
    async function fetchPrices() {
      const controller2 = new AbortController;
      const timeout = setTimeout(() => controller2.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(LITELLM_URL, { signal: controller2.signal });
        if (!response.ok)
          throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        const entries = parseLiteLLMPrices(json);
        if (Object.keys(entries).length === 0)
          throw new Error("empty price table");
        await updatePrices((draft) => {
          draft.fetchedAt = Date.now();
          draft.entries = entries;
          draft.error = "";
        });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await updatePrices((draft) => {
          draft.error = message;
        });
        return false;
      } finally {
        clearTimeout(timeout);
      }
    }
    function ensurePrices() {
      const fresh = Date.now() - prices.fetchedAt < PRICE_REFRESH_MS && Object.keys(prices.entries).length > 0;
      if (!fresh && priceFetch === undefined)
        priceFetch = fetchPrices().finally(() => priceFetch = undefined);
    }
    function forceRefreshPrices() {
      if (priceFetch === undefined)
        priceFetch = fetchPrices().finally(() => priceFetch = undefined);
      return priceFetch;
    }
    ensurePrices();
    const lookup = (providerID, modelID) => {
      const result = lookupPrice(prices.entries, providerID, modelID);
      return result.matched ? result.entry : undefined;
    };
    function priceStatus() {
      const entryCount = Object.keys(prices.entries).length;
      if (entryCount === 0 && priceFetch !== undefined)
        return { state: "loading", label: "prices: loading", ageMs: 0 };
      if (entryCount === 0 && prices.error !== "") {
        return { state: "unavailable", label: `prices: unavailable (${prices.error})`, ageMs: 0 };
      }
      if (prices.error !== "") {
        return { state: "error", label: `prices: fetch failed, cache ${formatAge(Date.now() - prices.fetchedAt)}`, ageMs: 0 };
      }
      return { state: "ok", label: `prices: ${formatAge(Date.now() - prices.fetchedAt)}`, ageMs: Date.now() - prices.fetchedAt };
    }
    const [revision, setRevision] = createSignal(0);
    const bump = () => setRevision((value) => value + 1);
    const familyUsages = new Map;
    const familyInflight = new Set;
    let viewedSessionID = "";
    let familyError = "";
    async function fetchUsages(sessionID) {
      const messages = await context.client.session.context({ sessionID });
      const usages = [];
      for (const message of messages) {
        if (message.type !== "assistant" || message.tokens === undefined)
          continue;
        usages.push({
          model: { providerID: message.model.providerID, id: message.model.id },
          tokens: message.tokens
        });
      }
      familyUsages.set(sessionID, { usages, fetchedAt: Date.now() });
      if (viewedSessionID !== "" && context.data.session.family(viewedSessionID).includes(sessionID)) {
        familyError = "";
      }
      bump();
    }
    function scheduleUsages(sessionID) {
      const entry = familyUsages.get(sessionID);
      if (entry !== undefined && Date.now() - entry.fetchedAt < FAMILY_REFRESH_MS)
        return;
      if (familyInflight.has(sessionID))
        return;
      familyInflight.add(sessionID);
      fetchUsages(sessionID).catch((error) => {
        familyError = error instanceof Error ? error.message : String(error);
      }).finally(() => familyInflight.delete(sessionID));
    }
    function sessionReport(sessionID) {
      if (sessionID !== viewedSessionID) {
        viewedSessionID = sessionID;
        familyError = "";
      }
      const rootID = context.data.session.root(sessionID);
      const family = context.data.session.family(sessionID);
      for (const id of family)
        scheduleUsages(id);
      return withSubagentNames(rollupFamily(family.map((id) => ({ sessionID: id, usages: familyUsages.get(id)?.usages ?? [] })), rootID, lookup), (id) => context.data.session.get(id)?.title ?? "");
    }
    let directoryCache;
    let directoryFetch;
    const PROJECT_DIRECTORY_TTL_MS = 60000;
    async function fetchProjectDirectories(projectID, sessionDirectory) {
      let reported = [];
      try {
        const entries = await context.client.worktree.list({ projectID });
        reported = entries.map((entry) => entry.directory);
      } catch {}
      return resolveProjectDirectories(reported, sessionDirectory);
    }
    function resolveDirectories(projectID, sessionDirectory) {
      const cached = directoryCache;
      if (cached !== undefined && cached.projectID === projectID && Date.now() - cached.fetchedAt < PROJECT_DIRECTORY_TTL_MS) {
        return Promise.resolve(cached.directories);
      }
      if (directoryFetch?.projectID === projectID)
        return directoryFetch.promise;
      const promise = fetchProjectDirectories(projectID, sessionDirectory).then((directories) => {
        directoryCache = { projectID, fetchedAt: Date.now(), directories };
        return directories;
      }).finally(() => {
        if (directoryFetch?.promise === promise)
          directoryFetch = undefined;
      });
      directoryFetch = { projectID, promise };
      return promise;
    }
    let projectCache;
    let projectCompute;
    let projectError = "";
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    function localDaysAgo(createdMs, nowMs) {
      const created = new Date(createdMs);
      created.setHours(0, 0, 0, 0);
      const today = new Date(nowMs);
      today.setHours(0, 0, 0, 0);
      return Math.round((today.getTime() - created.getTime()) / MS_PER_DAY);
    }
    async function computeProjectTotal(directories) {
      const now = Date.now();
      const inWindow = [];
      const seen = new Set;
      for (const directory of directories) {
        let cursor;
        let stop = false;
        while (!stop) {
          const page = await context.client.session.list({
            directory,
            order: "desc",
            limit: PROJECT_PAGE_LIMIT,
            cursor
          });
          for (const session of page.data) {
            if (shouldStopProjectPagination(session.time.created, now, inWindow.length)) {
              stop = true;
              break;
            }
            if (isInProjectWindow(session.time.created, now) && !seen.has(session.id)) {
              seen.add(session.id);
              inWindow.push({ id: session.id, created: session.time.created });
            }
          }
          cursor = page.cursor.next ?? undefined;
          if (cursor === undefined || stop)
            break;
        }
      }
      const days = [0, 0, 0, 0, 0, 0, 0];
      let total = 0;
      let saved = 0;
      const queue = [...inWindow];
      const workers = Array.from({ length: Math.min(PROJECT_FETCH_CONCURRENCY, queue.length) }, async () => {
        for (let session = queue.shift();session !== undefined; session = queue.shift()) {
          try {
            const messages = await context.client.session.context({ sessionID: session.id });
            let sessionTotal = 0;
            let sessionSaved = 0;
            for (const message of messages) {
              if (message.type !== "assistant" || message.tokens === undefined)
                continue;
              const entry = lookup(message.model.providerID, message.model.id);
              sessionTotal += computeTokenCost(message.tokens, entry);
              sessionSaved += computeTokenSavings(message.tokens, entry);
            }
            total += sessionTotal;
            saved += sessionSaved;
            const daysAgo = localDaysAgo(session.created, now);
            if (daysAgo >= 0 && daysAgo <= 6) {
              const slot = 6 - daysAgo;
              days[slot] = (days[slot] ?? 0) + sessionTotal;
            }
          } catch {}
        }
      });
      await Promise.all(workers);
      return { total, sessions: inWindow.length, days, saved };
    }
    function ensureProjectTotal(projectID, sessionDirectory) {
      const cached = projectCache;
      const now = Date.now();
      if (cached !== undefined && cached.projectID === projectID && !cached.dirty && now - cached.computedAt < PROJECT_TTL_MS) {
        return;
      }
      if (projectCompute === undefined) {
        projectCompute = resolveDirectories(projectID, sessionDirectory).then((directories) => computeProjectTotal(directories)).then((result) => {
          projectCache = {
            projectID,
            computedAt: Date.now(),
            dirty: false,
            total: result.total,
            sessions: result.sessions,
            days: result.days,
            saved: result.saved
          };
          projectError = "";
          bump();
        }).catch((error) => {
          projectError = error instanceof Error ? error.message : String(error);
        }).finally(() => projectCompute = undefined);
      }
    }
    function projectTotal(sessionID) {
      const session = context.data.session.get(sessionID);
      if (session === undefined)
        return { state: "loading", total: 0, sessionCount: 0, days: [], saved: 0, message: "" };
      ensureProjectTotal(session.projectID, session.location.directory);
      const cached = projectCache;
      if (cached !== undefined && cached.projectID === session.projectID) {
        return { state: "ok", total: cached.total, sessionCount: cached.sessions, days: cached.days, saved: cached.saved, message: "" };
      }
      if (projectError !== "")
        return { state: "error", total: 0, sessionCount: 0, days: [], saved: 0, message: projectError };
      return { state: "loading", total: 0, sessionCount: 0, days: [], saved: 0, message: "" };
    }
    function invalidateWorktrees() {
      directoryCache = undefined;
      if (projectCache !== undefined)
        projectCache.dirty = true;
      bump();
    }
    const stops = [
      context.data.on("session.usage.updated", () => {
        if (projectCache !== undefined)
          projectCache.dirty = true;
        if (viewedSessionID !== "") {
          for (const id of context.data.session.family(viewedSessionID))
            scheduleUsages(id);
        }
        bump();
      }),
      context.data.on("session.deleted", () => bump()),
      context.data.on("worktree.updated", invalidateWorktrees),
      context.data.on("worktree.resolved", invalidateWorktrees)
    ];
    const tick = setInterval(() => {
      ensurePrices();
      if (viewedSessionID !== "") {
        for (const id of context.data.session.family(viewedSessionID))
          scheduleUsages(id);
      }
      bump();
    }, PANEL_TICK_MS);
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
                const argument = (input ?? "").trim();
                if (argument !== "" && argument !== "refresh") {
                  context.ui.toast.show({ message: "Usage: /opencodebar refresh", variant: "info" });
                  return;
                }
                const ok = await forceRefreshPrices();
                if (ok) {
                  context.ui.toast.show({
                    message: `LiteLLM prices refreshed (${Object.keys(prices.entries).length} models, ${formatAge(0)})`,
                    variant: "success"
                  });
                } else {
                  context.ui.toast.show({ message: `Price refresh failed: ${prices.error}`, variant: "error" });
                }
                bump();
              }
            },
            {
              id: "opencodebar.doctor",
              title: "opencodebar: doctor (diagnose panel)",
              group: "opencodebar",
              slash: { name: "opencodebar-doctor", arguments: true },
              run: async (input) => {
                const argument = (input ?? "").trim();
                if (argument !== "") {
                  context.ui.toast.show({ message: "Usage: /opencodebar-doctor", variant: "info" });
                  return;
                }
                const entryCount = Object.keys(prices.entries).length;
                const pricePart = entryCount === 0 ? "prices: none" : `prices ${entryCount} models ${formatAge(Date.now() - prices.fetchedAt)}`;
                let verdict;
                let variant = "info";
                if (viewedSessionID === "") {
                  verdict = "no session viewed yet (open the panel first)";
                } else {
                  try {
                    const messages = await context.client.session.context({ sessionID: viewedSessionID });
                    const billed = [];
                    for (const message of messages) {
                      if (message.type === "assistant" && message.tokens !== undefined) {
                        billed.push({ model: message.model, tokens: message.tokens });
                      }
                    }
                    const total = billed.reduce((sum, usage) => sum + computeTokenCost(usage.tokens, lookup(usage.model.providerID, usage.model.id)), 0);
                    const cached = familyUsages.get(viewedSessionID)?.usages.length ?? 0;
                    if (billed.length === 0) {
                      verdict = `DATA: session ${viewedSessionID.slice(0, 8)} has ${messages.length} msgs, none with tokens`;
                    } else if (cached > 0) {
                      verdict = `live $${total.toFixed(4)} over ${billed.length} billed msgs, cache has ${cached} usages — if the panel still shows $0, the render is frozen (restart the client)`;
                    } else {
                      verdict = `PANEL FETCH STUCK: live $${total.toFixed(4)} works but the panel cache is empty · familyErr ${familyError || "none"}`;
                    }
                  } catch (error) {
                    variant = "error";
                    verdict = `DATA FETCH FAILED: ${error instanceof Error ? error.message : String(error)}`;
                  }
                }
                context.ui.toast.show({
                  message: `opencodebar doctor · ${pricePart} · rev ${revision()} · ${verdict}`,
                  variant
                });
              }
            }
          ]
        }));
        return null;
      }
    });
    const controller = {
      revision,
      sessionReport,
      projectTotal,
      priceStatus,
      errors: () => ({ family: familyError, project: projectError })
    };
    const theme = {
      text: context.theme.text.base,
      muted: context.theme.text.muted,
      error: context.theme.text.feedback.error.base,
      warning: context.theme.text.feedback.warning.base
    };
    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => /* @__PURE__ */ jsxDEV2(CostPanel, {
        sessionID: input.sessionID,
        ctrl: controller,
        theme
      }, undefined, false, undefined, this)
    });
    return () => {
      clearInterval(tick);
      stopSlot();
      stopKeymapSlot();
      for (const stop of stops)
        stop();
    };
  }
});
export {
  tui_default as default
};
