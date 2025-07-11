# office-peak-worker

Jamf Pro インベントリ API から **「今日オフィスに居たピーク人数」** を集計し、  
平日 18:30 JST に Slack へ自動投稿する Cloudflare Workers スクリプトです。  
オンプレ機器や GitHub Actions を使わず、**完全サーバーレス** で運用できます。

---

## 📐 アーキテクチャ概要

```
┌─ Cron Trigger ────────────────┐
│ 0 * * * MON-FRI (毎時)         │
│ 30 9 * * MON-FRI (18:30 JST) │
└─────┬───────────────┬────────┘
      │               │
      ▼               ▼
┌──────────────┐ ┌────────────┐
│ Jamf Pro API │ │ Workers KV │
└─────┬────────┘ └─────┬──────┘
      │ 集計 max        │ 1 日分保持
      ▼                 ▼
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
crons = ["0 * * * MON-FRI", "30 9 * * MON-FRI"]  # UTC

[[kv_namespaces]]
binding = "PEAK_KV"
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
# wrangler secret put JAMF_SCOPE "READ_COMPUTERS READ_COMPUTER_INVENTORY_COLLECTION"

# 4. KV 名前空間を作成
wrangler kv:namespace create PEAK_KV

# 5. デプロイ
wrangler publish
```

### ダッシュボード派の方へ

すべて UI から設定可能です。  
Settings → Triggers で Cron、Variables で Secrets、KV Namespaces でバインドを追加してください。

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

```bash
# ローカルで fetch テスト
wrangler dev

# 別ターミナル: scheduled イベントを擬似呼び出し
wrangler dev --test scheduled "0 * * * MON-FRI"
```

- Cloudflare ダッシュボード → Logs を開いて `occupancy current=...` が出れば成功
- Run test から `"30 9 * * MON-FRI"` を指定すると Slack へ即投稿されます

---

## 🙋‍♂️ FAQ

| Q | A |
|---|---|
| 在席数が多すぎる | `OFFICE_NETS` が正しいか、Jamf で報告される IP が想定通りか確認 |
| 昨日の端末が残る | クライアント側 `jamf recon` の頻度を上げる／スリープ復帰時トリガー |
| Jamf OAuth が 400 | Client ID と Scope の整合をチェック。必要なら `JAMF_SCOPE` を設定 |
| 休日も集計したい | Cron の `MON-FRI` を削除すれば土日も実行 |

---

## 📝 ライセンス

MIT License  
