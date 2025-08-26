# office-peak-worker

Jamf Pro インベントリ API から「オフィスに居たピーク人数」を集計し、  
- 平日 18:30 JST に **日次ピークを Slack へ投稿**  
- 月末 18:00 JST に **月次まとめを Slack へ投稿**  

する Cloudflare Workers スクリプトです。  
オンプレ機器や GitHub Actions を使わず、完全サーバーレスで運用できます。

---

## 📐 アーキテクチャ概要



---

## 📐 アーキテクチャ概要

```
┌─ Cron Trigger ────────────────┐
│ 0 * * * MON-FRI (毎時集計) │
│ 30 9 * * MON-FRI (18:30 JST) │
│ 0 9 * * * (18:00 JST) │
└─────┬───────────────┬────────┘
│ │
▼ ▼
┌──────────────┐ ┌────────────┐
│ Jamf Pro API │ │ Workers KV │
└─────┬────────┘ └─────┬──────┘
│ 集計 max │ 日次/⽉次保持
▼ ▼
┌──────────────┐
│ Slack Webhook│
└──────────────┘
```

---

## ✨ 機能

| 機能 | 説明 |
|------|------|
| **在席数カウント** | 1 時間おきに Jamf Pro `/api/v1/computers-inventory` を取得し、<br>`lastIpAddress` がオフィス CIDR 内 **かつ** その日の `lastInventoryUpdate` がある Mac を集計 |
| **ピーク保持** | Workers KV に `YYYY-MM-DD → max人数` を保存（TTL 48 h） |
| **Slack 通知** | 平日 18:30 JST（UTC 09:30）の Cron でピーク人数を投稿 |
| **リセット** | 投稿後に該当キーを削除し、翌日は新キーで再集計 |

---

## 📋 前提条件

| ソフト / サービス | 最低バージョン | 備考 |
|------------------|--------------|------|
| **Cloudflare Workers** | Free プランで可 | KV バインドが 1 個必要 |
| **Jamf Pro** | 10.14 以降 | API v1 が利用可能 |
| **macOS クライアント** | – | `jamf recon` を 30 分間隔程度で実行推奨 |
| **Slack** | – | Incoming Webhook が有効なワークスペース |

---

---

## ✨ 機能

| 機能            | 説明 |
|-----------------|------|
| 在席数カウント   | 1時間おきに Jamf Pro `/api/v1/computers-inventory` を取得し、`lastIpAddress` がオフィス CIDR 内、かつ当日の `lastInventoryUpdate` がある Mac を集計 |
| 日次ピーク投稿   | 平日 18:30 JST に Slack へピーク人数を投稿。同時に `STATS_KV` に保存 |
| 月次まとめ投稿   | 毎日18:00 JSTに「翌日が別月か」を判定し、月末なら Slack に月次まとめを投稿（平均・最大/最小・曜日平均・週平均・上位5日・日別一覧） |
| KV 永続化        | `STATS_KV` に `YYYY-MM/DD` → 人数を保存（約13か月保持） |
| 検証用エンドポイント | `/test-monthly` で即時月次まとめ投稿、`/month?...` で JSON/CSV 出力 |

---

## 📋 前提条件

| ソフト / サービス  | 最低バージョン | 備考 |
|--------------------|----------------|------|
| Cloudflare Workers | Free プランで可 | KV バインドが 2 個必要 (`PEAK_KV`, `STATS_KV`) |
| Jamf Pro           | 10.14 以降     | API v1 が利用可能 |
| macOS クライアント | –              | `jamf recon` を 30分間隔程度で実行推奨 |
| Slack              | –              | Incoming Webhook が有効なワークスペース |

---

## 🚀 デプロイ手順（CLI）

```bash
# 1. プロジェクト作成
wrangler init office-peak --type=javascript
cd office-peak
cp ../worker.js src/worker.js   # 本リポジトリの worker.js を配置

# 2. wrangler.toml
cat <<'TOML' > wrangler.toml
name = "office-peak"
main = "src/worker.js"
compatibility_date = "2025-07-08"

[triggers]
crons = ["0 * * * MON-FRI", "30 9 * * MON-FRI", "0 9 * * *"]  # UTC

[[kv_namespaces]]
binding = "PEAK_KV"
id = "<KV_NAMESPACE_ID>"

[[kv_namespaces]]
binding = "STATS_KV"
id = "<KV_NAMESPACE_ID>"
TOML

# 3. Secrets / 環境変数
wrangler secret put JAMF_URL              # 例: https://example.jamfcloud.com
wrangler secret put OFFICE_NETS           # 例: 10.0.5.0/24,203.0.113.0/25
wrangler secret put SLACK_WEBHOOK_URL

# 認証は片方のみ
wrangler secret put JAMF_CLIENT_ID
wrangler secret put JAMF_CLIENT_SECRET
#     ── または ──
wrangler secret put JAMF_USER
wrangler secret put JAMF_PASS

# (OAuth で scope が必須なら)
wrangler secret put JAMF_SCOPE "Read Computer Inventory Collection Read Computers"

# 4. KV 名前空間を作成
wrangler kv:namespace create PEAK_KV
wrangler kv:namespace create STATS_KV

# 5. デプロイ
wrangler publish


---

## 🗝️ 環境変数一覧

| 変数 | 必須 | 説明 |
|------|------|------|
| `JAMF_URL` | ✔ | `https://xxx.jamfcloud.com`（末尾スラッシュなし） |
| `OFFICE_NETS` | ✔ | `10.0.5.0/24,203.0.113.0/25` など複数可 |
| `SLACK_WEBHOOK_URL` | ✔ | Slack Incoming Webhook |
| `JAMF_CLIENT_ID` / `_SECRET` | – | OAuth2 (Client Credentials) |
| `JAMF_USER` / `_PASS` | – | Basic 認証 |
| `JAMF_SCOPE` | – | OAuth Scope が必要な場合のみ |

※ OAuth と Basic 認証は **どちらか一方だけ** 設定してください。

### 📋 Jamf Pro OAuth2 スコープについて

OAuth2 認証を使用する場合、以下のスコープが必要です：

```bash
# 必要なスコープを設定
wrangler secret put JAMF_SCOPE "Read Computer Inventory Collection Read Computers"
```

**必要なスコープ一覧：**
- `Read Computer Inventory Collection` - コンピューター インベントリ情報の読み取り
- `Read Computers` - コンピューター基本情報の読み取り

Jamf Pro 管理画面でのスコープ設定は：
1. **Settings** → **System** → **API Roles and Clients** 
2. **API Clients** タブで該当クライアントを選択
3. **Privileges** で上記スコープを有効化

---

## 🧪 テスト方法

```
# ローカルで fetch テスト
wrangler dev

# 別ターミナル: scheduled イベントを擬似呼び出し
wrangler dev --test scheduled "0 * * * MON-FRI"
```

- Cloudflare ダッシュボード → Logs を開いて `occupancy current=...` が出れば成功
- Run test から `"30 9 * * MON-FRI"` を指定すると Slack へ即投稿されます

---
🧪 テスト方法

日次まとめ投稿テスト
Run test → cron = "30 9 * * MON-FRI" で Slack 投稿されるか確認

月次まとめ投稿テスト
https://<your-worker>.workers.dev/test-monthly を叩くと即時 Slack に投稿
（STATS_KV にデータがあることが前提）

日次データ確認

```
/month?yyyy-mm=2025-08        # JSON 出力
/month?yyyy-mm=2025-08&format=csv  # CSV 出力
```

🔧 テスト用エンドポイントの消し方

Worker コードの fetch() 内を開き、以下の if 文を削除：
```
if (url.pathname === "/test-monthly") { ... }
if (url.pathname === "/test-slack") { ... }
```


Save & Deploy

削除後に /test-monthly や /test-slack にアクセスすると
"office-peak worker ready" が返るようになる
---

🙋‍♂️ FAQ

Q. 在席数が多すぎる
A. OFFICE_NETS が正しいか、Jamf で報告される IP が想定通りか確認

Q. 昨日の端末が残る
A. クライアント側 jamf recon の頻度を上げる／スリープ復帰時に実行

Q. Jamf OAuth が 400
A. Client ID と Scope の整合を確認。必要なら JAMF_SCOPE を設定

Q. 休日も集計したい
A. Cron の MON-FRI を削除すれば土日も実行される

📝 ライセンス

MIT License
