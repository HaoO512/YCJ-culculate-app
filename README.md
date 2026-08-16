# 億起記

借款收息記帳 iPhone App（PWA）。月曆看收息日、前一天 09:30 自動推播提醒、欠繳自動累計欠息、Excel 匯出匯入。

資料存放（v3.0）：手機本機為工作副本，並**自動同步到使用者自己的 Cloudflare 帳號**（KV，同步金鑰保護，含姓名與金額的明文帳目；雲端每日快照保留 31 天）。不使用第三方伺服器，Cloudflare 帳號由使用者本人持有。

## 安裝到 iPhone

1. Safari 打開 App 網址（GitHub Pages）
2. 點「分享」→「加入主畫面」
3. 主畫面點「億起記」圖示使用，離線可用

## 提醒設定

預設用系統推播（設定 → 開啟通知提醒）。要用行事曆的話：設定 →「行事曆（選用）」→「下載全部行事曆提醒」→ 點「加入」。

## 備份

統計頁 →「匯出 Excel 檔」，一檔三表（借款主表、問題帳目、收款記錄），傳電腦或 LINE 保存。換手機用「匯入 Excel 檔」還原。

## 開發

- `docs/` = App 本體（純 HTML/CSS/JS + SheetJS），GitHub Pages 從 main 分支 /docs 服務
- [REQUIREMENTS.md](REQUIREMENTS.md) 需求清單 · [TECH_PLAN.md](TECH_PLAN.md) 技術方案
- 本機試跑：`npx http-server docs -p 8123`

## 雲端同步（v3.0）

- 後端：`worker/` = Cloudflare Worker（yiqiji-sync.haoo512.workers.dev），免費額度
- 資料：帳目自動同步到 Cloudflare KV，雲端每日自動快照保留 31 天
- 提醒：系統推播是預設提醒方式（前一天與當天 09:30）。行事曆匯出僅為手動選用功能，任何記帳、編輯或狀態變更都不會自動下載行事曆檔
- 金鑰：統計頁「顯示同步金鑰」，換手機輸入金鑰即可取回全部資料
- 部署後端：`cd worker && npx wrangler deploy`
- 測試：`node tests/test-calc.mjs`、`tests/test-prepaid.mjs`、`tests/test-io.mjs`
