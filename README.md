# office-peak-worker

Jamf Pro のインベントリ API から **「今日オフィスにいた最大人数」** を集計し、  
平日 18:30 JST に Slack へ自動投稿する Cloudflare Workers スクリプトです。  
ラズパイやオンプレサーバ不要、完全サーバーレスで運用できます。

![architecture](./docs/architecture.svg) <!-- 任意で図を追加 -->

---

## 機能概要

| 機能 | 説明 |
|------|------|
| **在席数カウント** | 1 時間ごとに Jamf Pro `/api/v1/computers-inventory` を取得し、<br>`lastIpAddress` が社内サブネットに一致 *かつ* その日の `lastInventoryUpdate` がある Mac をユニークユーザーで集計 |
| **ピーク保持** | Workers KV に `YYYY-MM-DD → max人数` を保存（48 h TTL 付き） |
| **Slack 通知** | 平日 18:30 JST（UTC 09:30）の Cron でピーク人数を投稿 |
| **リセット** | 投稿後に KV キーを削除。日付が変われば自動的に新キーに切替 |

---

## 前提条件

| 要素 | バージョン / 備考 |
|------|------------------|
| Cloudflare アカウント | Workers + KV 無料枠で動作可 |
| Jamf Pro | 10.14 以降（API v1 利用） |
| Mac クライアント | 30 分おき程度で `jamf recon` が走る設定推奨 |
| Slack | Incoming Webhook が有効なワークスペース |

---

## デプロイ手順（CLI 編）

```bash
# 1. プロジェクト作成
wrangler init office-peak --type=javascript
cd office-peak
# 2. src/worker.js をこのリポジトリのものに置き換え
cp ../worker.js src/worker.js

# 3. wrangler.toml を編集
cat <<'TOML' > wrangler.toml
name = "office-peak"
main = "src/worker.js"
compatibility_date = "2025-07-08"

[triggers]
crons = ["0 * * * MON-FRI", "30 9 * * MON-FRI"] # UTC

[[kv_namespaces]]
binding = "PEAK_KV"
id = "<作成したKVのID>"
TOML

# 4. Secrets & 環境変数
wrangler secret put JAMF_URL              # https://xxxx.jamfcloud.com
wrangler secret put OFFICE_NETS           # 例: 10.0.5.0/24,203.0.113.0/25
wrangler secret put SLACK_WEBHOOK_URL

# 認証は *どちらか* を選択
wrangler secret put JAMF_CLIENT_ID
wrangler secret put JAMF_CLIENT_SECRET
#  — または —
wrangler secret put JAMF_USER
wrangler secret put JAMF_PASS

# 5. KV 名前空間
wrangler kv:namespace create PEAK_KV

# 6. デプロイ
wrangler publish

ダッシュボード操作派の方
Workers & Pages → Create Worker

Quick Edit で worker.js を貼り付け → Save & Deploy

Settings → KV Namespaces で PEAK_KV をバインド

Settings → Variables に上記 Secrets を登録

Settings → Triggers で Cron を 2 本追加

0 * * * MON-FRI（平日毎時 00 分）

30 9 * * MON-FRI（平日 09:30 UTC = 18:30 JST）

環境変数一覧
変数	必須	例	説明
JAMF_URL	✅	https://xxx.jamfcloud.com	Jamf Pro URL（末尾 / 不要）
OFFICE_NETS	✅	10.0.5.0/24,203.0.113.0/25	オフィスのプライベート / グローバル IP（カンマ区切り複数可）
SLACK_WEBHOOK_URL	✅	https://hooks.slack.com/...	投稿先 Webhook
JAMF_CLIENT_ID	任意	–	OAuth2 (Client Credentials) ID
JAMF_CLIENT_SECRET	任意	–	同上 Secret
JAMF_USER	任意	–	Basic 認証ユーザー
JAMF_PASS	任意	–	同上パスワード
JAMF_SCOPE	任意	READ_COMPUTERS	OAuth2 scope 明示が必要な場合のみ設定

OAuth2 (CLIENT_ID/SECRET) と Basic (USER/PASS) は どちらか片方だけ 設定してください。

ローカルテスト
bash
コピーする
編集する
wrangler dev # http://localhost:8787/
# 別ターミナルで擬似 scheduled イベントを発火
wrangler dev --test scheduled "0 * * * MON-FRI"
よくある質問
質問	回答
在席数が多すぎる	OFFICE_NETS が正しいか / Mac の IP が想定サブネットか確認。BYOD 重複はユーザー名で排除しています。
昨日の端末が残る	クライアントで jamf recon が十分頻度高く動いているか、スリープ復帰時トリガーを検討。
Jamf OAuth が 400	Client ID と Scope が一致しているか。Scope 必須なら JAMF_SCOPE を設定。
休日も投稿したい	Cron の MON-FRI を削除すれば土日も実行されます。

ライセンス
MIT License



> **補足**  
> * `docs/architecture.svg` は任意。図があれば置いてください。  
> * コマンド例は **wrangler v3** 基準です。  
> * ライセンス表記は自社ポリシーに合わせて変更してください。
::contentReference[oaicite:0]{index=0}
