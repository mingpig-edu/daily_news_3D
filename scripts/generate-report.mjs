import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL_OVERRIDE = (process.env.GEMINI_MODEL || "").trim();
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY. Add it as a GitHub Actions repository secret.");
  process.exit(1);
}

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

async function apiFetch(url, options = {}) {
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
  // Accept stable text-output Flash names such as gemini-3.7-flash or gemini-2.5-flash-001.
  // Excludes Flash-Lite, image, TTS, preview and experimental variants.
  const match = /^gemini-(\d+(?:\.\d+)*)-flash(?:-(\d{3}))?$/.exec(name);
  if (!match) return null;
  return {
    parts: match[1].split(".").map(Number),
    pinned: Boolean(match[2])
  };
}

function compareVersionsDesc(a, b) {
  const max = Math.max(a.version.parts.length, b.version.parts.length);
  for (let i = 0; i < max; i += 1) {
    const av = a.version.parts[i] ?? 0;
    const bv = b.version.parts[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  // Prefer the normal stable alias over a pinned -001 variant of the same release.
  if (a.version.pinned !== b.version.pinned) return Number(a.version.pinned) - Number(b.version.pinned);
  return a.name.localeCompare(b.name);
}

function buildModelCandidates(models) {
  const discovered = models
    .map((model) => ({
      name: cleanModelName(model.name),
      methods: model.supportedGenerationMethods || []
    }))
    .filter((model) => model.methods.includes("generateContent"))
    .map((model) => ({ ...model, version: stableFlashVersion(model.name) }))
    .filter((model) => model.version)
    .sort(compareVersionsDesc);

  const names = [];
  if (MODEL_OVERRIDE) names.push(MODEL_OVERRIDE);
  names.push(...discovered.map((model) => model.name));

  // If an account exposes no versioned stable Flash names, keep Google's moving alias as a last resort.
  const latestAliasAvailable = models.some(
    (model) => cleanModelName(model.name) === "gemini-flash-latest" &&
      (model.supportedGenerationMethods || []).includes("generateContent")
  );
  if (latestAliasAvailable) names.push("gemini-flash-latest");

  return [...new Set(names)];
}

function isModelCompatibilityError(error) {
  if (!(error instanceof GeminiApiError)) return false;
  if (error.status === 404) return true;

  const text = error.detail.toLowerCase();
  const compatibilityWords = [
    "not supported",
    "unsupported",
    "not available",
    "no longer available",
    "not found",
    "does not support"
  ];
  const featureWords = [
    "model",
    "google_search",
    "google search",
    "grounding",
    "responseschema",
    "response schema",
    "structured output"
  ];

  if (error.status === 400) {
    return compatibilityWords.some((word) => text.includes(word)) &&
      featureWords.some((word) => text.includes(word));
  }

  // Only treat a 403 as model-specific when the message clearly refers to model access.
  // Generic API-key, project, billing or permission failures must stop immediately.
  if (error.status === 403) {
    const looksModelSpecific = text.includes("model") && compatibilityWords.some((word) => text.includes(word));
    const looksAccountWide = ["api key", "billing", "project", "permission denied"].some((word) => text.includes(word));
    return looksModelSpecific && !looksAccountWide;
  }

  return false;
}

function isTransientServerError(error) {
  return error instanceof GeminiApiError && [500, 502, 503, 504].includes(error.status);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function generateWithFallback({ taskName, body, candidates, startAt = 0 }) {
  let lastError;

  for (let index = startAt; index < candidates.length; index += 1) {
    const model = candidates[index];
    console.log(`${taskName}: trying ${model}${index > startAt ? " (fallback)" : ""}...`);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const data = await callModel(model, body);
        return { data, model, index };
      } catch (error) {
        lastError = error;

        if (isTransientServerError(error) && attempt < 2) {
          console.warn(`${taskName}: ${model} returned ${error.status}; retrying once...`);
          await sleep(1500);
          continue;
        }

        if (isModelCompatibilityError(error) || isTransientServerError(error)) {
          console.warn(`${taskName}: ${model} unavailable/incompatible (${error.status}); trying the next Flash model.`);
          break;
        }

        // Authentication, quota/rate limit, billing and malformed-request errors stop here.
        throw error;
      }
    }
  }

  throw lastError || new Error(`No compatible Gemini Flash model was available for ${taskName}.`);
}

function responseText(data) {
  return (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n")
    .trim();
}

function groundingSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  return chunks
    .map((chunk, index) => ({
      id: index,
      title: chunk?.web?.title || "Web source",
      uri: chunk?.web?.uri || ""
    }))
    .filter((source) => {
      if (!source.uri || seen.has(source.uri)) return false;
      seen.add(source.uri);
      return true;
    });
}

console.log("Discovering Gemini Flash models available to this API key...");
const availableModels = await listModels();
const modelCandidates = buildModelCandidates(availableModels);
if (!modelCandidates.length) {
  throw new Error("This API key currently exposes no Gemini Flash model that supports generateContent.");
}
console.log(`Flash fallback order: ${modelCandidates.join(" -> ")}`);

const topicText = config.topics.map((topic) => `- ${topic}`).join("\n");
const researchPrompt = `
你是一名 3D 列印產業情報編輯。今天（${config.timezone}）是 ${reportDate}。
請使用 Google Search 搜尋最近 ${config.lookback_hours} 小時內最值得留意的 3D 列印新消息；若最近 48 小時消息不足，可納入最近 7 天內仍具持續影響的重要消息，但要清楚交代日期。

重點範圍：
${topicText}

要求：
1. 優先採用官方公告、原廠、專業媒體、研究機構或可信來源。
2. 排除單純 SEO 文章、內容農場、沒有新資訊的舊聞翻炒。
3. 不要為了湊數而加入低價值消息。
4. 每一項候選消息交代：事件、日期、為何重要、涉及品牌／技術。
5. 如不同來源互相矛盾，要指出不確定性。
6. 請以${config.language}撰寫。

先完成研究，再輸出一份可供編輯整理的詳盡文字稿。`;

console.log(`[1/2] Researching ${reportDate} with Google Search...`);
const researchResult = await generateWithFallback({
  taskName: "Research",
  candidates: modelCandidates,
  body: {
    contents: [{ parts: [{ text: researchPrompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 7000 }
  }
});
const researchText = responseText(researchResult.data);
const sources = groundingSources(researchResult.data);
if (!researchText) throw new Error("Gemini returned no research text.");
console.log(`Research model: ${researchResult.model}`);
console.log(`Found ${sources.length} grounded source(s).`);

const sourceCatalogue = sources.map((s) => `[${s.id}] ${s.title} — ${s.uri}`).join("\n");
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
          title: { type: "STRING" },
          category: { type: "STRING" },
          summary: { type: "STRING" },
          why_it_matters: { type: "STRING" },
          tags: { type: "ARRAY", items: { type: "STRING" } },
          source_ids: { type: "ARRAY", items: { type: "INTEGER" } }
        },
        required: ["title", "category", "summary", "why_it_matters", "tags", "source_ids"]
      }
    }
  },
  required: ["title", "summary", "items"]
};

const editorialPrompt = `
你現在是日報總編輯。根據下面的「研究稿」與「可用來源清單」，製作 ${reportDate} 的《3D 列印每日情報》。

規則：
- 使用${config.language}。
- 最多 ${config.max_items} 項；寧缺勿濫。
- 按重要性排序。
- title 簡潔，不誇張、不 clickbait。
- summary 約 2–4 句，說清楚發生甚麼。
- why_it_matters 用一句話解釋為何值得 3D 列印使用者／Maker 留意。
- category 使用簡短分類，例如「硬件」「材料」「軟件」「產業」「開源」「安全」「應用」。
- source_ids 只能使用下方來源清單中真實存在的數字 ID；不要自行創造 URL。
- 沒有可靠來源支持的候選消息不要收入。

研究稿：
---
${researchText}
---

可用來源清單：
${sourceCatalogue || "（沒有取得可用來源；這種情況下 items 應為空陣列。）"}
`;

console.log("[2/2] Structuring report...");
const structuredResult = await generateWithFallback({
  taskName: "Editorial",
  candidates: modelCandidates,
  // Start with the model that successfully completed research. If structured output is
  // unsupported for it, continue downward from there rather than jumping back upward.
  startAt: researchResult.index,
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
console.log(`Editorial model: ${structuredResult.model}`);

const sourceMap = new Map(sources.map((s) => [s.id, { title: s.title, uri: s.uri }]));
const items = (parsed.items || []).slice(0, config.max_items).map((item) => ({
  title: item.title,
  category: item.category,
  summary: item.summary,
  why_it_matters: item.why_it_matters,
  tags: Array.isArray(item.tags) ? item.tags.slice(0, 6) : [],
  sources: [...new Set(Array.isArray(item.source_ids) ? item.source_ids : [])]
    .map((id) => sourceMap.get(id))
    .filter(Boolean)
}));

const report = {
  schema_version: 1,
  date: reportDate,
  generated_at: now.toISOString(),
  model: structuredResult.model,
  models: {
    research: researchResult.model,
    editorial: structuredResult.model
  },
  title: parsed.title || `3D 列印每日情報｜${reportDate}`,
  summary: parsed.summary || "",
  items
};

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
  items: items.length,
  model: structuredResult.model
});
reports.sort((a, b) => b.date.localeCompare(a.date));
const nextManifest = { latest: reports[0]?.date || null, reports };
await fs.writeFile(manifestPath, JSON.stringify(nextManifest, null, 2) + "\n");

console.log(`Saved ${reportFile} with ${items.length} item(s).`);
