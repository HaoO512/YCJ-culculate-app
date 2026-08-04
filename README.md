# 億起記

借款收息記帳 iPhone App（PWA）。月曆看收息日、行事曆前一天 09:30 提醒、欠繳自動累計欠息、Excel 匯出匯入。資料只存手機本機，不上雲。

## 安裝到 iPhone

1. Safari 打開 App 網址（GitHub Pages）
2. 點「分享」→「加入主畫面」
3. 主畫面點「億起記」圖示使用，離線可用

## 提醒設定

每筆借款詳情頁 →「加到行事曆」→ 點「加入」。之後每月收息日前一天早上 09:30、當天 09:30 各提醒一次。

## 備份

統計頁 →「匯出 Excel 檔」，一檔三表（借款主表、問題帳目、收款記錄），傳電腦或 LINE 保存。換手機用「匯入 Excel 檔」還原。

## 開發

- `docs/` = App 本體（純 HTML/CSS/JS + SheetJS），GitHub Pages 從 main 分支 /docs 服務
- [REQUIREMENTS.md](REQUIREMENTS.md) 需求清單 · [TECH_PLAN.md](TECH_PLAN.md) 技術方案
- 本機試跑：`npx http-server docs -p 8123`
