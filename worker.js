// Cloudflare Worker (JavaScript) – stable
// Counts hourly office occupancy via Jamf Pro and posts the daily peak to Slack.
//   • Uses fallback: HEAD request to find valid inventory endpoint (no section / GENERAL)
//   • JST same‑day filter
//   • Debug logs removed
// ─────────────────────────────────────────────
export default {
  async fetch() {
    return new Response("office‑peak worker ready", { status: 200 });
  },

  async scheduled(event, env) {
    const todayJST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const isPost   = event.cron === "30 9 * * MON-FRI"; // 18:30 JST

    if (isPost) {
      const peak = (await env.PEAK_KV.get(todayJST, "json")) || 0;
      await postSlack(env, peak, todayJST);
      await env.PEAK_KV.delete(todayJST);
      return;
    }

    const current = await countOccupancy(env, todayJST);
    const stored  = (await env.PEAK_KV.get(todayJST, "json")) || 0;
    console.log(`occupancy current=${current}, storedMax=${stored}`);
    if (current > stored) {
      await env.PEAK_KV.put(todayJST, JSON.stringify(current), { expirationTtl: 172800 });
    }
  },
};

/* ───────── helper fns ───────── */
const ipToInt = (ip) => ip.split(".").reduce((a, o) => ((a << 8) | (+o & 255)) >>> 0, 0);
const ipInCidr = (ip, cidr) => {
  const [net, bits] = cidr.split("/");
  const mask = bits ? 0xffffffff << (32 - +bits) : 0;
  return (ipToInt(ip) & mask) === (ipToInt(net) & mask);
};
const normalizeCidrs = (s) => s.split(",").map((v) => v.trim()).filter(Boolean).map((c) => (c.includes("/") ? c : `${c}/32`));
const ipInCidrs = (ip, cidrs) => cidrs.some((c) => ipInCidr(ip, c));

async function getJamfToken(env) {
  const base = env.JAMF_URL.replace(/\/+$/, "");
  if (env.JAMF_CLIENT_ID && env.JAMF_CLIENT_SECRET) {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: env.JAMF_CLIENT_ID, client_secret: env.JAMF_CLIENT_SECRET });
    const r = await fetch(`${base}/api/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!r.ok) throw new Error(`OAuth ${r.status}`);
    return (await r.json()).access_token;
  }
  if (env.JAMF_USER && env.JAMF_PASS) {
    const r = await fetch(`${base}/api/v1/auth/token`, { method: "POST", headers: { Authorization: `Basic ${btoa(env.JAMF_USER + ":" + env.JAMF_PASS)}` } });
    if (!r.ok) throw new Error(`Basic ${r.status}`);
    return (await r.json()).token;
  }
  throw new Error("Jamf credentials missing");
}

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

async function postSlack(env, peak, date) {
  await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `本日の在席ピークは *${peak} 人* でした。（${date}）` }),
  });
}
