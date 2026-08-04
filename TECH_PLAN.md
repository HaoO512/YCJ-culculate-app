# 借貸管家 — 技術方案（v1，免費 PWA 路線）

> 對應 REQUIREMENTS.md v2.0。定案：免費、免 Apple 帳號、提醒外接蘋果行事曆。

## 1. 總體架構

```
iPhone Safari「加入主畫面」
        │
   PWA（純前端，無後端）
   ├── UI：原生 HTML/CSS/JS（無框架、無打包步驟）
   ├── 資料：localStorage（JSON，單機、離線）
   ├── 匯出／匯入：SheetJS（xlsx，一檔三表）
   ├── 提醒：產生 .ics → 蘋果行事曆（每月重複＋前一天鬧鈴）
   └── service worker：離線快取（斷網照用）
        │
   靜態託管：GitHub Pages（免費、HTTPS，PWA 必要條件）
```

沒有伺服器。資料只存在手機瀏覽器本機。GitHub Pages 只放程式碼（公開的是 App 外殼，不是帳目資料）。

## 2. 技術選型與理由

| 選擇 | 理由 |
|---|---|
| 純 HTML/CSS/JS，無框架 | 規模小（單人、幾十筆借款）；零建置步驟，改完即部署；十年後還能維護 |
| localStorage | 資料量小（<1MB），同步 API 簡單；每次匯出 xlsx 即備份 |
| SheetJS（xlsx.full.min.js，本地 vendor） | 匯出／匯入 xlsx 業界標準；vendor 進 repo，不吃 CDN |
| .ics + RRULE:FREQ=MONTHLY | 行事曆原生月重複；VALARM -P1D = 前一天提醒；零伺服器 |
| GitHub Pages | 免費 HTTPS 靜態託管，git push 即部署 |

## 3. 檔案結構

```
docs/   ← GitHub Pages 從 main 分支 /docs 服務
├── index.html            單頁：五個畫面切換
├── manifest.webmanifest  PWA 名稱、圖示、主題色（橘黃 #D9730D）
├── sw.js                 service worker：cache-first 離線
├── icons/                apple-touch-icon 180 / 192 / 512
├── css/app.css           設計稿 token 直接移植（橘黃主色、錢紅綠）
├── js/
│   ├── store.js          localStorage 讀寫、資料結構、版本遷移
│   ├── calc.js           利息、介紹費、欠繳累計、統計（純函數）
│   ├── ics.js            .ics 產生器
│   ├── xlsx-io.js        匯出／匯入（SheetJS 包裝）
│   └── app.js            畫面渲染、路由、事件
└── vendor/xlsx.full.min.js
```

## 4. 資料結構（localStorage key: `loanapp.v1`）

```js
{
  version: 1,
  loans: [{
    id, name,                 // 借款人
    principal,                // 本金
    rate,                     // 月利率 %（1.5–2）
    startDate,                // 借款日 "2026-08-04"
    dueDay,                   // 收息日（1–28，>28 記為 "EOM" 月底）
    status,                   // normal | overdue | legal | closed
    overdueSince,             // 停繳日（欠繳時才有）
    finalReceived,            // 法院結案實收（結案時才有）
    referralFee,              // 介紹費（預設 = 月息 × 0.5，可改）
    appraisalFee,             // 代書費（預設 3000，可改）
    note
  }],
  payments: [{ id, loanId, date, amount }]   // 收款記錄
}
```

## 5. 核心計算（calc.js，全部純函數可測）

- 月息 `= round(principal × rate / 100)`
- 介紹費預設 `= 月息 × 0.5`；代書費預設 `3000`
- 欠繳期數 `= overdueSince 起，已過的收息日個數（單利）`
- 累計欠息 `= 欠繳期數 × 月息`
- 壞帳沖銷 `= (未還本金 + 累計欠息) − finalReceived`（legal 結案時）
- 統計：放出本金（未結清）、已收利息 Σpayments、本月待收、費用累計、淨收入、欠繳總額

## 6. .ics 提醒規格

每筆借款一個 VEVENT（全天事件，UID 固定 = loan.id，重加會更新不會重複）：

```
DTSTART;VALUE=DATE:<下一個收息日>
RRULE:FREQ=MONTHLY;BYMONTHDAY=<dueDay>     // dueDay>28 → BYMONTHDAY=-1（月底）
SUMMARY:收〈名字〉利息 $〈金額〉
VALARM TRIGGER:-PT14H30M → 前一天 09:30 通知
VALARM TRIGGER:PT9H30M   → 當天 09:30 再提醒一次
```

操作流：新增借款 → 詳情頁「加到行事曆」→ Safari 開 .ics → 點「加入」。結清／欠繳時 App 提示到行事曆刪該事件（.ics 無法遠端刪除，此為已知限制）。

## 7. xlsx 匯出／匯入

- 匯出：一檔三表「借款主表／問題帳目／收款記錄」，欄名繁中，Safari 分享面板傳電腦、LINE、iCloud
- 匯入：讀同格式檔，逐列驗證（必填、數字、日期），錯誤列出行號不硬蓋；成功才整批取代
- 匯出檔 = 備份檔。換手機：舊機匯出 → 新機匯入

## 8. 部署與安裝流程

1. `app/` 推上 GitHub repo，開 GitHub Pages
2. 爸的 iPhone Safari 開網址 → 分享 →「加入主畫面」
3. 之後點主畫面圖示 = 全螢幕 App，離線可用
4. 更新：git push 後，App 重開自動吃新版（service worker 更新策略：stale-while-revalidate）

## 9. 風險與對策

| 風險 | 對策 |
|---|---|
| iOS 清 Safari 資料會清掉 localStorage | 「加入主畫面」的 PWA 儲存區獨立，一般不受清 Safari 影響；再靠 xlsx 定期備份提醒（App 內建「上次備份 N 天前」提示） |
| .ics 無法自動刪除已結清事件 | 結清流程內建提示 + 教學圖 |
| 大月小月 29–31 號 | dueDay>28 一律月底規則 |
| SheetJS 檔案大（~900KB） | vendor 本地 + service worker 快取，只有首次載入吃流量 |
```
