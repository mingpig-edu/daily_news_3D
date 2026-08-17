const state = { manifest: null, index: -1 };
const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setStatus(text) { el("status").textContent = text; }

function renderSources(sources = []) {
  if (!sources.length) return `<p>此項未能可靠對應來源。</p>`;
  return `<ul>${sources.map((source) => {
    const title = escapeHtml(source.title || source.uri || "來源");
    const uri = String(source.uri || "");
    if (!/^https?:\/\//i.test(uri)) return `<li>${title}</li>`;
    return `<li><a href="${uri.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${title}</a></li>`;
  }).join("")}</ul>`;
}

function renderReport(report) {
  el("emptyState").hidden = true;
  el("report").hidden = false;
  el("reportDate").textContent = report.date || "";
  el("reportTitle").textContent = report.title || "3D 列印每日情報";
  el("reportSummary").textContent = report.summary || "";

  const cards = (report.items || []).map((item, i) => `
    <details class="card" ${i === 0 ? "open" : ""}>
      <summary>
        <span class="rank">${String(i + 1).padStart(2, "0")}</span>
        <span>
          <span class="card-title">${escapeHtml(item.title)}</span>
          <span class="category">${escapeHtml(item.category || "其他")}</span>
        </span>
        <span class="toggle" aria-hidden="true">+</span>
      </summary>
      <div class="card-body">
        <div>
          <p>${escapeHtml(item.summary)}</p>
          ${item.why_it_matters ? `<p class="why">為何值得留意：${escapeHtml(item.why_it_matters)}</p>` : ""}
          <div class="tags">${(item.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
        </div>
        <aside class="sources">
          <h4>Sources</h4>
          ${renderSources(item.sources)}
        </aside>
      </div>
    </details>
  `).join("");
  el("cards").innerHTML = cards || "<p>本日沒有足夠重要的更新。</p>";
}

async function loadReport(index) {
  const entry = state.manifest.reports[index];
  if (!entry) return;
  setStatus("讀取日報…");
  try {
    const response = await fetch(`./reports/${entry.file}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const report = await response.json();
    state.index = index;
    el("reportSelect").value = String(index);
    el("prevBtn").disabled = index >= state.manifest.reports.length - 1;
    el("nextBtn").disabled = index <= 0;
    renderReport(report);
    setStatus(`更新：${report.generated_at ? new Date(report.generated_at).toLocaleString("zh-HK") : report.date}`);
  } catch (error) {
    console.error(error);
    setStatus("讀取失敗");
  }
}

async function init() {
  try {
    const response = await fetch("./reports/index.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.manifest = await response.json();
    const reports = state.manifest.reports || [];
    if (!reports.length) {
      el("emptyState").hidden = false;
      el("report").hidden = true;
      setStatus("等待首份日報");
      return;
    }
    const select = el("reportSelect");
    select.innerHTML = reports.map((r, i) => `<option value="${i}">${escapeHtml(r.date)}</option>`).join("");
    select.disabled = false;
    el("prevBtn").disabled = reports.length < 2;
    el("nextBtn").disabled = true;
    select.addEventListener("change", (event) => loadReport(Number(event.target.value)));
    el("prevBtn").addEventListener("click", () => loadReport(state.index + 1));
    el("nextBtn").addEventListener("click", () => loadReport(state.index - 1));
    await loadReport(0);
  } catch (error) {
    console.error(error);
    el("emptyState").hidden = false;
    el("emptyState").querySelector("h2").textContent = "網站資料載入失敗";
    el("emptyState").querySelector("p").textContent = "請確認 reports/index.json 存在並為有效 JSON。";
    setStatus("載入失敗");
  }
}

document.addEventListener("DOMContentLoaded", init);
