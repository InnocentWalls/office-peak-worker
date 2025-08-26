// Cloudflare Worker – Office occupancy (daily + monthly summary)
// - Jamf Pro から当日分を集計して KV に保存
// - 平日18:30 JST に日次ピークを Slack へ
// - 毎日18:00 JST に「月末か」を判定し、月次まとめを Slack へ（Blocks + 日別一覧 + 曜日/週平均）
// - STATS_KV に月内の日別ピークを保持（約13か月）
// - /test-monthly で“今すぐ”月次まとめを投稿（テスト用途）
// --------------------------------------------------------------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // --- テスト投稿: /test-monthly を叩くと当月のまとめを即時投稿 ---
    if (url.pathname === "/test-monthly") {
      const now = new Date(Date.now() + 9 * 3600 * 1000); // JST
      const monthKey = now.toISOString().slice(0, 7);     // YYYY-MM
      await postMonthlySummary(env, monthKey);
      return new Response("monthly summary posted (test)", { status: 200 });
    }

    // オンデマンド参照: /month?yyyy-mm=2025-08&format=csv|json
    if (url.pathname === "/month") {
      const month = url.searchParams.get("yyyy-mm");
      const format = (url.searchParams.get("format") || "json").toLowerCase();
      if (!/^\d{4}-\d{2}$/.test(month)) return new Response("bad month", { status: 400 });

      const list = await env.STATS_KV.list({ prefix: `${month}/` });
      const items = [];
      for (const k of list.keys) {
        const v = await env.STATS_KV.get(k.name, "json");
        if (typeof v === "number" && Number.isFinite(v)) {
          items.push({ date: k.name.slice(-10), value: v });
        }
      }
      items.sort((a, b) => a.date.localeCompare(b.date));

      if (format === "csv") {
        const csv = ["date,value", ...items.map(i => `${i.date},${i.value}`)].join("\n");
        return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8" } });
      }
      return new Response(JSON.stringify(items), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("office-peak worker ready", { status: 200 });
  },

  async scheduled(event, env) {
    const now = Date.now();
    const jstNow = new Date(now + 9 * 3600 * 1000);
    const todayJST = jstNow.toISOString().slice(0, 10); // YYYY-MM-DD
    const monthKey = todayJST.slice(0, 7);              // YYYY-MM

    const isDailyPost  = event.cron === "30 9 * * MON-FRI"; // 平日18:30 JST
    const isMonthCheck = event.cron === "0 9 * * *";        // 毎日18:00 JST

    if (isDailyPost) {
      // 1) 日次ピーク Slack 投稿
      const peak = (await env.PEAK_KV.get(todayJST, "json")) ?? 0;
      await postSlackDaily(env, peak, todayJST);

      // 2) 月別ストアにも保存（当日分）
      await env.STATS_KV.put(`${monthKey}/${todayJST}`, JSON.stringify(peak), {
        // 約13か月保持（400日）
        expirationTtl: 400 * 24 * 3600,
      });
      // PEAK_KV は一時保存用途。不要なら削除してもOK（現状は残す）
      return;
    }

    // 月末チェック（毎日18:00 JST）
    if (isMonthCheck && isMonthEndJST(jstNow)) {
      await postMonthlySummary(env, monthKey);
      return;
    }

    // 通常カウント（Jamfから同日分を走査し、最大値を PEAK_KV へ反映）
    const current = await countOccupancy(env, todayJST);
    const stored  = (await env.PEAK_KV.get(todayJST, "json")) ?? 0;
    if (current > stored) {
      await env.PEAK_KV.put(todayJST, JSON.stringify(current), { expirationTtl: 172800 }); // 2日
    }
  },
};

/* ───────── helper: IP/CIDR ───────── */
const ipToInt = (ip) => ip.split(".").reduce((a, o) => ((a << 8) | (+o & 255)) >>> 0, 0);
const ipInCidr = (ip, cidr) => {
  const [net, bits] = cidr.split("/");
  const mask = bits ? (0xffffffff << (32 - +bits)) >>> 0 : 0;
  return (ipToInt(ip) & mask) === (ipToInt(net) & mask);
};
const normalizeCidrs = (s) => s.split(",").map((v) => v.trim()).filter(Boolean).map((c) => (c.includes("/") ? c : `${c}/32`));
const ipInCidrs = (ip, cidrs) => cidrs.some((c) => ipInCidr(ip, c));

/* ───────── helper: date ───────── */
function isMonthEndJST(jstDateObj) {
  // 「JSTの明日」が別月なら、今日はJSTの月末
  const tomorrow = new Date(jstDateObj.getTime() + 24 * 3600 * 1000);
  const ymd = (d) => new Date(d.getTime()).toISOString().slice(0, 10);
  const today = ymd(jstDateObj);
  const tmr   = ymd(tomorrow);
  return today.slice(0, 7) !== tmr.slice(0, 7);
}

/* ───────── Jamf token ───────── */
async function getJamfToken(env) {
  const base = env.JAMF_URL.replace(/\/+$/, "");
  if (env.JAMF_CLIENT_ID && env.JAMF_CLIENT_SECRET) {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.JAMF_CLIENT_ID,
      client_secret: env.JAMF_CLIENT_SECRET,
    });
    const r = await fetch(`${base}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!r.ok) throw new Error(`OAuth ${r.status}`);
    return (await r.json()).access_token;
  }
  if (env.JAMF_USER && env.JAMF_PASS) {
    const r = await fetch(`${base}/api/v1/auth/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(env.JAMF_USER + ":" + env.JAMF_PASS)}` },
    });
    if (!r.ok) throw new Error(`Basic ${r.status}`);
    return (await r.json()).token;
  }
  throw new Error("Jamf credentials missing");
}

/* ───────── Jamf inventory endpoint ───────── */
async function selectInventoryUrl(base, headers) {
  const candidates = [
    `${base}/api/v1/computers-inventory?page-size=500`,
    `${base}/api/v1/computers-inventory?section=GENERAL&page-size=500`,
  ];
  for (const u of candidates) {
    const h = await fetch(u, { method: "HEAD", headers });
    if (h.ok) return u;
  }
  throw new Error("All inventory endpoints 400");
}

/* ───────── occupancy count ───────── */
async function countOccupancy(env, todayJST) {
  const token   = await getJamfToken(env);
  const base    = env.JAMF_URL.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  let url       = await selectInventoryUrl(base, headers);

  const cidrs = normalizeCidrs(env.OFFICE_NETS || "");
  const users = new Set();

  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Inventory ${res.status}`);
    const { results, pagination } = await res.json();

    for (const c of results) {
      const ts = c.general?.lastContactTime || c.general?.lastInventoryUpdate || "";
      if (ts.slice(0, 10) !== todayJST) continue;
      const ip = c.general?.lastIpAddress;
      if (ip && ipInCidrs(ip, cidrs)) {
        users.add(c.general?.reportingUsername || c.general?.name || String(c.id));
      }
    }
    url = pagination?.next ?? "";
  }
  return users.size;
}

/* ───────── Slack posts ───────── */
async function postSlackDaily(env, peak, date) {
  await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `本日の在席ピークは *${peak} 人* でした。（${date}）`,
    }),
  });
}

async function postSlackMonthly(env, month, stats, items, weekdayAvgs, weekAvgs) {
  // items: [["YYYY-MM-DD", number], ...] 昇順
  const { days, avg, max, maxDate, min, minDate } = stats;
  const top5 = [...items].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // 日別テーブル（最大値比の簡易バー含む）
  const maxVal = Math.max(...items.map(([, v]) => v));
  const tableLines = items.map(([d, v]) => {
    const bar = sparkBar(v, maxVal, 20); // 20セル幅
    return `${d} | ${String(v).padStart(3)} | ${bar}`;
  });

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `📊 ${month} 在席まとめ` } },
    { type: "section", text: { type: "mrkdwn", text:
      [
        `・*対象日数*: ${days} 日`,
        `・*平均(人)*: ${fmt(avg)}`,
        `・*最大(人)*: ${max}（${maxDate}）`,
        `・*最小(人)*: ${min}（${minDate}）`,
      ].join("\n")
    }},
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text:
      "*曜日平均*\n" + weekdayAvgs.join("\n")
    }},
    { type: "section", text: { type: "mrkdwn", text:
      "*週平均*\n" + weekAvgs.join("\n")
    }},
    (top5.length ? {
      type: "section", text: { type: "mrkdwn", text:
        "*上位5日*\n" + top5.map(([d, v], i) => ` ${i + 1}. ${d}: ${v}`).join("\n")
      }
    } : null),
    { type: "section", text: { type: "mrkdwn", text:
      "*日別一覧*\n```" + tableLines.join("\n") + "```"
    }},
  ].filter(Boolean);

  await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });
}

const fmt = (n) => (Number.isFinite(n) ? (Math.round(n * 10) / 10).toString() : "-");

// Unicode ブロックで簡易バー（0〜1を20マスに）
function sparkBar(value, max, width = 20) {
  if (!max || max <= 0) return " ".repeat(width);
  const ratio = Math.max(0, Math.min(1, value / max));
  const full = Math.floor(ratio * width);
  const remainder = (ratio * width) - full;
  const eighths = Math.round(remainder * 8); // 1/8刻み
  const cells = " ▁▂▃▄▅▆▇█"; // 0..8段
  const head = cells[Math.min(cells.length - 1, eighths)];
  return "█".repeat(full) + (full < width ? head + " ".repeat(Math.max(0, width - full - 1)) : "");
}

/* ───────── monthly aggregation ───────── */
async function postMonthlySummary(env, monthKey) {
  // 1) 当月キー一覧
  const list = await env.STATS_KV.list({ prefix: `${monthKey}/` });
  if (!list.keys.length) return;

  // 2) 値取得（昇順ソート）
  const items = [];
  for (const k of list.keys) {
    const v = await env.STATS_KV.get(k.name, "json");
    if (typeof v === "number" && Number.isFinite(v)) {
      items.push([k.name.slice(-10), v]); // [YYYY-MM-DD, value]
    }
  }
  if (!items.length) return;
  items.sort((a, b) => a[0].localeCompare(b[0]));

  // 3) 基本統計
  const values = items.map(([, v]) => v);
  const days = values.length;
  const avg = values.reduce((a, b) => a + b, 0) / days;
  let max = -Infinity, maxDate = "", min = Infinity, minDate = "";
  for (const [d, v] of items) {
    if (v > max) { max = v; maxDate = d; }
    if (v < min) { min = v; minDate = d; }
  }

  // 4) 曜日平均・週平均（JST基準）
  const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];
  const weekdaySums = Array(7).fill(0), weekdayCounts = Array(7).fill(0);
  const weekSums = {}, weekCounts = {};

  for (const [d, v] of items) {
    // d は "YYYY-MM-DD"
    const dateObj = new Date(d + "T00:00:00Z");
    const jst = new Date(dateObj.getTime() + 9 * 3600 * 1000);
    const wd = jst.getUTCDay(); // 0=日
    weekdaySums[wd] += v; weekdayCounts[wd]++;

    // その月の第何週か（JST、月初の曜日からオフセット）
    const firstDay = new Date(jst.getFullYear(), jst.getMonth(), 1);
    const weekNum = Math.floor((jst.getDate() + firstDay.getDay() - 1) / 7) + 1;
    weekSums[weekNum] = (weekSums[weekNum] || 0) + v;
    weekCounts[weekNum] = (weekCounts[weekNum] || 0) + 1;
  }

  const weekdayAvgs = weekdaySums.map((sum, i) =>
    weekdayCounts[i] ? `${weekdayLabels[i]}曜: ${fmt(sum / weekdayCounts[i])}` : null
  ).filter(Boolean);

  const weekAvgs = Object.keys(weekSums).sort((a,b)=>+a-+b).map(num =>
    `第${num}週: ${fmt(weekSums[num] / weekCounts[num])}`
  );

  // 5) Slack 投稿（Blocks + 日別一覧 + 曜日/週平均）
  await postSlackMonthly(
    env,
    monthKey,
    { days, avg, max, maxDate, min, minDate },
    items,
    weekdayAvgs,
    weekAvgs
  );

  // 6) データ保持: 削除しない（約13か月で TTL により自然消滅）
}
