import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const MODEL_OVERRIDE = (process.env.GEMINI_MODEL || "").trim();
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const config = JSON.parse(await fs.readFile(path.join(ROOT, "brief.config.json"), "utf8"));
const now = new Date();
const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
const reportDate = dateFmt.format(now);

class GeminiApiError extends Error {
  constructor(status, detail, model = "") {
    super(`Gemini API ${status}${model ? ` (${model})` : ""}: ${detail.slice(0, 1200)}`);
    this.name = "GeminiApiError";
    this.status = status;
    this.detail = detail;
    this.model = model;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function stripHtml(value = "") {
  return decodeEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagText(block, tagNames) {
  for (const tag of tagNames) {
    const escaped = tag.replace(":", "\\:");
    const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i").exec(block);
    if (match) return stripHtml(match[1]);
  }
  return "";
}

function tagRaw(block, tagNames) {
  for (const tag of tagNames) {
    const escaped = tag.replace(":", "\\:");
    const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i").exec(block);
    if (match) return decodeEntities(match[1]).trim();
  }
  return "";
}

function extractLink(block) {
  const atomAlternate = /<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(block)
    || /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(block);
  if (atomAlternate?.[1]) return decodeEntities(atomAlternate[1]).trim();
  return tagText(block, ["link"]);
}

function safeDate(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time) : null;
}

function parseFeed(xml, feed) {
  const itemBlocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const entryBlocks = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
  const blocks = itemBlocks.length ? itemBlocks : entryBlocks;

  return blocks.map((block) => {
    const title = tagText(block, ["title"]);
    const url = extractLink(block) || tagText(block, ["guid", "id"]);
    const rawDescription = tagRaw(block, ["content:encoded", "content", "description", "summary"]);
    const summary = stripHtml(rawDescription).slice(0, config.max_excerpt_chars || 700);
    const publishedRaw = tagText(block, ["pubDate", "published", "updated", "dc:date"]);
    const published = safeDate(publishedRaw);
    return {
      title,
      url,
      summary,
      published_at: published ? published.toISOString() : null,
      published_ms: published ? published.getTime() : 0,
      source: feed.name,
      feed_url: feed.url,
      feed_mode: feed.mode || "all"
    };
  }).filter((item) => item.title && /^https?:\/\//i.test(item.url || ""));
}

function normalizeTitle(value = "") {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function normalizeUrl(value = "") {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function keywordMatch(item) {
  if (item.feed_mode !== "keyword") return true;
  const haystack = `${item.title} ${item.summary}`.toLowerCase();
  return (config.keywords || []).some((keyword) => haystack.includes(String(keyword).toLowerCase()));
}

function dedupe(items) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const output = [];
  for (const item of items) {
    const urlKey = normalizeUrl(item.url);
    const titleKey = normalizeTitle(item.title);
    if ((urlKey && seenUrls.has(urlKey)) || (titleKey && seenTitles.has(titleKey))) continue;
    if (urlKey) seenUrls.add(urlKey);
    if (titleKey) seenTitles.add(titleKey);
    output.push({ ...item, url: urlKey || item.url });
  }
  return output;
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.feed_timeout_ms || 15000);
  try {
    const response = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; 3DPrintDailyBrief/0.1.3; +https://github.com/)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const items = parseFeed(xml, feed);
    if (!items.length) throw new Error("Feed returned no parseable items");
    return { feed, items, ok: true };
  } catch (error) {
    return { feed, items: [], ok: false, error: error?.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function chooseCandidateWindow(items) {
  const recentCutoff = now.getTime() - (config.lookback_hours || 72) * 3600_000;
  const fallbackCutoff = now.getTime() - (config.fallback_days || 7) * 86400_000;
  const recent = items.filter((item) => !item.published_ms || item.published_ms >= recentCutoff);
  const fallback = items.filter((item) => !item.published_ms || item.published_ms >= fallbackCutoff);
  const chosen = recent.length >= (config.min_recent_candidates || 6) ? recent : fallback;
  return chosen
    .sort((a, b) => (b.published_ms || 0) - (a.published_ms || 0))
    .slice(0, config.max_candidates || 40);
}

function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "x-goog-api-key": API_KEY,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
}

async function listModels() {
  const models = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await apiFetch(`${API_BASE}/models?${params}`);
    if (!response.ok) {
      const detail = await response.text();
      throw new GeminiApiError(response.status, `Unable to list available models. ${detail}`);
    }
    const data = await response.json();
    models.push(...(data.models || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return models;
}

function cleanModelName(name = "") {
  return name.replace(/^models\//, "");
}

function stableFlashVersion(name) {
  const match = /^gemini-(\d+(?:\.\d+)*)-flash(-lite)?(?:-(\d{3}))?$/.exec(name);
  if (!match) return null;
  return {
    parts: match[1].split(".").map(Number),
    lite: Boolean(match[2]),
    pinned: Boolean(match[3])
  };
}

function compareVersionsDesc(a, b) {
  const max = Math.max(a.version.parts.length, b.version.parts.length);
  for (let i = 0; i < max; i += 1) {
    const av = a.version.parts[i] ?? 0;
    const bv = b.version.parts[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  if (a.version.lite !== b.version.lite) return Number(a.version.lite) - Number(b.version.lite);
  if (a.version.pinned !== b.version.pinned) return Number(a.version.pinned) - Number(b.version.pinned);
  return a.name.localeCompare(b.name);
}

function buildModelCandidates(models) {
  const discovered = models
    .map((model) => ({ name: cleanModelName(model.name), methods: model.supportedGenerationMethods || [] }))
    .filter((model) => model.methods.includes("generateContent"))
    .map((model) => ({ ...model, version: stableFlashVersion(model.name) }))
    .filter((model) => model.version)
    .sort(compareVersionsDesc);

  const names = [];
  if (MODEL_OVERRIDE) names.push(MODEL_OVERRIDE);
  names.push(...discovered.map((model) => model.name));
  for (const alias of ["gemini-flash-latest", "gemini-flash-lite-latest"]) {
    if (models.some((model) => cleanModelName(model.name) === alias && (model.supportedGenerationMethods || []).includes("generateContent"))) {
      names.push(alias);
    }
  }
  return [...new Set(names)];
}

function isModelCompatibilityError(error) {
  if (!(error instanceof GeminiApiError)) return false;
  if (error.status === 404) return true;
  const text = error.detail.toLowerCase();
  if (error.status === 400) {
    return ["not supported", "unsupported", "not available", "no longer available", "not found", "does not support"]
      .some((word) => text.includes(word));
  }
  return false;
}

function isRateLimitError(error) {
  return error instanceof GeminiApiError && error.status === 429;
}

function isTransientServerError(error) {
  return error instanceof GeminiApiError && [500, 502, 503, 504].includes(error.status);
}

async function callModel(model, body) {
  const response = await apiFetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new GeminiApiError(response.status, detail, model);
  }
  return response.json();
}

async function generateWithFallback({ taskName, body, candidates }) {
  let lastError;
  for (let index = 0; index < candidates.length; index += 1) {
    const model = candidates[index];
    console.log(`${taskName}: trying ${model}${index ? " (fallback)" : ""}...`);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const data = await callModel(model, body);
        return { data, model };
      } catch (error) {
        lastError = error;
        if ((isRateLimitError(error) || isTransientServerError(error)) && attempt < 2) {
          const delayMs = 1600 + Math.floor(Math.random() * 900);
          console.warn(`${taskName}: ${model} returned ${error.status}; retrying once after ${delayMs}ms...`);
          await sleep(delayMs);
          continue;
        }
        if (isModelCompatibilityError(error) || isRateLimitError(error) || isTransientServerError(error)) {
          console.warn(`${taskName}: ${model} unavailable/quota-limited (${error.status}); trying next Flash model.`);
          break;
        }
        throw error;
      }
    }
  }
  throw lastError || new Error(`No compatible Gemini Flash model was available for ${taskName}.`);
}

function responseText(data) {
  return (data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("\n").trim();
}

function inferCategory(item) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  if (/filament|resin|material|pla|petg|nylon|tpu|peek/.test(text)) return "材料";
  if (/slicer|firmware|software|orca|prusaslicer|cura|cad|open.source|github/.test(text)) return "軟件／開源";
  if (/recall|security|vulnerability|safety|fire|warning/.test(text)) return "安全";
  if (/research|medical|education|university|industrial|aerospace|automotive/.test(text)) return "應用／科研";
  return "硬件／產業";
}

function detectTags(item) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const tags = [];
  const map = [
    ["Bambu Lab", /bambu/], ["Prusa", /prusa/], ["Creality", /creality/], ["Elegoo", /elegoo/],
    ["Anycubic", /anycubic/], ["FDM", /\bfdm\b|\bfff\b/], ["Resin", /resin|sla|msla/],
    ["材料", /filament|material|pla|petg|nylon|tpu/], ["開源", /open.source|github/]
  ];
  for (const [label, regex] of map) if (regex.test(text)) tags.push(label);
  return tags.slice(0, 6);
}

function basicReport(candidates, feedResults, reason = "") {
  const items = candidates.slice(0, config.max_items).map((item) => ({
    title: item.title,
    category: inferCategory(item),
    summary: item.summary ? item.summary.slice(0, 280) : `來自 ${item.source} 的最新消息。`,
    why_it_matters: "本項為原始 RSS／Atom 資訊；Gemini 整理暫不可用，請按來源查看完整內容。",
    tags: detectTags(item),
    sources: [{ title: item.source, uri: item.url }]
  }));
  const okFeeds = feedResults.filter((result) => result.ok).length;
  return {
    schema_version: 2,
    date: reportDate,
    generated_at: now.toISOString(),
    model: null,
    models: { editorial: null },
    generation_mode: "basic-rss",
    title: `3D 列印每日情報｜${reportDate}`,
    summary: `今日從 ${okFeeds} 個公開 RSS／Atom 來源收集資訊。AI 整理暫不可用，以下按時間列出較新的候選消息${reason ? `（${reason}）` : ""}。`,
    items
  };
}

console.log(`[1/2] Collecting RSS/Atom feeds for ${reportDate}...`);
const configuredFeeds = Array.isArray(config.feeds) ? config.feeds : [];
if (!configuredFeeds.length) throw new Error("brief.config.json has no feeds configured.");
const feedResults = await Promise.all(configuredFeeds.map(fetchFeed));
for (const result of feedResults) {
  if (result.ok) console.log(`Feed OK: ${result.feed.name} (${result.items.length} item(s))`);
  else console.warn(`Feed skipped: ${result.feed.name} — ${result.error}`);
}

const collected = dedupe(feedResults.flatMap((result) => result.items).filter(keywordMatch));
const candidates = chooseCandidateWindow(collected);
console.log(`Collected ${collected.length} relevant unique item(s); ${candidates.length} candidate(s) selected.`);

let report;
if (!candidates.length) {
  report = basicReport([], feedResults, "沒有取得近期可用消息");
} else if (!API_KEY) {
  console.warn("GEMINI_API_KEY is missing; generating basic RSS report without AI.");
  report = basicReport(candidates, feedResults, "未設定 Gemini API Key");
} else {
  try {
    console.log("Discovering Gemini Flash models available to this API key...");
    const availableModels = await listModels();
    const modelCandidates = buildModelCandidates(availableModels);
    if (!modelCandidates.length) throw new Error("No Gemini Flash model supporting generateContent is available.");
    console.log(`Flash fallback order: ${modelCandidates.join(" -> ")}`);

    const sourceCatalogue = candidates.map((item, index) => {
      const date = item.published_at ? item.published_at.slice(0, 10) : "日期不明";
      const excerpt = (item.summary || "").slice(0, config.max_excerpt_chars || 700);
      return `[${index}] ${item.title}\n日期：${date}\n來源：${item.source}\n網址：${item.url}\n摘要：${excerpt}`;
    }).join("\n\n");

    const topicText = (config.topics || []).map((topic) => `- ${topic}`).join("\n");
    const schema = {
      type: "OBJECT",
      properties: {
        title: { type: "STRING" },
        summary: { type: "STRING" },
        items: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              source_id: { type: "INTEGER" },
              title: { type: "STRING" },
              category: { type: "STRING" },
              summary: { type: "STRING" },
              why_it_matters: { type: "STRING" },
              tags: { type: "ARRAY", items: { type: "STRING" } }
            },
            required: ["source_id", "title", "category", "summary", "why_it_matters", "tags"]
          }
        }
      },
      required: ["title", "summary", "items"]
    };

    const editorialPrompt = `
你是 3D 列印每日情報總編輯。今天（${config.timezone}）是 ${reportDate}。
下面是程式從公開 RSS／Atom 來源收集到的候選消息。你不能上網搜尋，也不能加入候選資料以外的新事件。

關注範圍：
${topicText}

請製作《3D 列印每日情報》，規則：
1. 使用${config.language}。
2. 最多 ${config.max_items} 項，寧缺勿濫，按重要性排序。
3. 優先選真正的新產品、重大更新、新材料、重要軟件／韌體、開源項目、科研應用、安全／召回或產業變化。
4. 排除廣告感太強、純購物指南、一般教學、沒有新資訊的內容。
5. 只能根據候選消息的標題與摘要整理；資料不足時要保守，不可補作不存在的細節。
6. source_id 必須使用候選消息中真實存在的編號，而且一個輸出項目只對應一個最主要來源。
7. title 簡潔；summary 約 2–4 句；why_it_matters 一句說明實際意義。
8. category 使用「硬件」「材料」「軟件」「產業」「開源」「安全」「應用」「科研」等短分類。

候選消息：
${sourceCatalogue}
`;

    console.log("[2/2] Gemini is selecting and structuring the report (no Google Search grounding)...");
    const structuredResult = await generateWithFallback({
      taskName: "Editorial",
      candidates: modelCandidates,
      body: {
        contents: [{ parts: [{ text: editorialPrompt }] }],
        generationConfig: {
          maxOutputTokens: 6000,
          responseMimeType: "application/json",
          responseSchema: schema
        }
      }
    });

    const jsonText = responseText(structuredResult.data);
    if (!jsonText) throw new Error("Gemini returned no structured report.");
    const parsed = JSON.parse(jsonText);
    const items = (parsed.items || []).slice(0, config.max_items).map((item) => {
      const source = candidates[Number(item.source_id)];
      if (!source) return null;
      return {
        title: item.title,
        category: item.category,
        summary: item.summary,
        why_it_matters: item.why_it_matters,
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 6) : [],
        sources: [{ title: source.source, uri: source.url }]
      };
    }).filter(Boolean);

    report = {
      schema_version: 2,
      date: reportDate,
      generated_at: now.toISOString(),
      model: structuredResult.model,
      models: { editorial: structuredResult.model },
      generation_mode: "rss-plus-gemini",
      title: parsed.title || `3D 列印每日情報｜${reportDate}`,
      summary: parsed.summary || "",
      items
    };
    console.log(`Editorial model: ${structuredResult.model}`);
  } catch (error) {
    const reason = error instanceof GeminiApiError ? `Gemini ${error.status}` : (error?.message || "Gemini 暫不可用");
    console.warn(`AI editorial unavailable: ${reason}. Falling back to basic RSS report.`);
    report = basicReport(candidates, feedResults, reason);
  }
}

report.feed_status = feedResults.map((result) => ({
  name: result.feed.name,
  url: result.feed.url,
  ok: result.ok,
  items: result.items.length,
  error: result.ok ? null : result.error
}));
report.candidate_count = candidates.length;

const reportsDir = path.join(ROOT, "docs", "reports");
await fs.mkdir(reportsDir, { recursive: true });
const reportFile = `${reportDate}.json`;
await fs.writeFile(path.join(reportsDir, reportFile), JSON.stringify(report, null, 2) + "\n");

const manifestPath = path.join(reportsDir, "index.json");
let manifest = { latest: null, reports: [] };
try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch {}
const reports = (manifest.reports || []).filter((entry) => entry.date !== reportDate);
reports.push({
  date: reportDate,
  file: reportFile,
  generated_at: report.generated_at,
  items: report.items.length,
  model: report.model,
  mode: report.generation_mode
});
reports.sort((a, b) => b.date.localeCompare(a.date));
await fs.writeFile(manifestPath, JSON.stringify({ latest: reports[0]?.date || null, reports }, null, 2) + "\n");

console.log(`Saved ${reportFile} with ${report.items.length} item(s), mode=${report.generation_mode}.`);
