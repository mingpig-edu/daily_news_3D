# 3D 列印每日情報 — GitHub Pages 極簡版

這是由原 Manus Web App 簡化而成的 GitHub-only 版本：**沒有伺服器、沒有資料庫、沒有登入系統、沒有 npm 依賴**。

## 它怎樣運作

1. GitHub Actions 每天在 `Asia/Hong_Kong` 07:17 執行。
2. Action 從 GitHub Secret 讀取 `GEMINI_API_KEY`。
3. Gemini 先透過 Google Search 做即時研究，再進行第二階段 JSON 結構化整理。
4. 日報寫入 `docs/reports/YYYY-MM-DD.json`。
5. 同一個 workflow 立即部署 `docs/` 到 GitHub Pages。

API Key **不會寫入網站、日報 JSON 或 repository**。

## 第一次設定（只需做一次）

### 1. 建立 GitHub repository 並上傳本專案

建議 repository 名稱：`3d-print-daily-brief`

### 2. 加入 Gemini API Key

GitHub repository → **Settings → Secrets and variables → Actions → New repository secret**

名稱必須是：

```text
GEMINI_API_KEY
```

把你的 Gemini API Key 貼入 Value 後儲存。

### 3. 開啟 GitHub Pages

Repository → **Settings → Pages → Build and deployment → Source → GitHub Actions**

完成。

## 第一次測試

Repository → **Actions → Daily 3D Print Brief → Run workflow**

成功後會出現：

```text
docs/reports/YYYY-MM-DD.json
```

而 GitHub Pages 網站亦會更新。

## 日常使用

不需要任何操作。預設每天香港時間 **07:17** 自動更新。

如要修改排程，編輯 `.github/workflows/daily-brief.yml` 中：

```yaml
- cron: '17 7 * * *'
  timezone: 'Asia/Hong_Kong'
```

## 可選調整

`brief.config.json` 可修改：

- 語言
- 每日最多消息數量
- 搜尋回溯時間
- 關注主題

## 檔案結構

```text
.github/workflows/daily-brief.yml  # 每日自動生成 + Pages 部署
docs/index.html                    # 網站首頁
docs/assets/style.css              # 樣式
docs/assets/app.js                 # 日報讀取與互動
docs/reports/index.json            # 日報索引
scripts/generate-report.mjs         # Gemini 搜尋與生成
brief.config.json                   # 簡單設定
```

## 安全原則

- 不要把真實 API Key 寫入任何 `.js`、`.html`、`.json` 或 `.env` 後提交到 GitHub。
- API Key 只放在 GitHub Actions Secret：`GEMINI_API_KEY`。
- GitHub Pages 前端只讀取已生成的日報，不會呼叫 Gemini API。
- Fork 本專案的人必須加入自己的 `GEMINI_API_KEY` 才能生成日報。

## 從 Manus 版本移除了甚麼

- Manus runtime / Forge API
- React / Vite
- Express / tRPC
- MySQL / Drizzle
- OAuth 使用者登入
- S3 storage
- 伺服器部署依賴

保留的核心目標只有：**每天自動搜尋 → 整理 → 保存 → 網頁閱讀**。
