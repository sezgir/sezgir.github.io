// Sezgir stats API: stores one score per player per day, returns daily aggregates.
const DATE = /^\d{4}-\d{2}-\d{2}$/, CLIENT = /^[a-z0-9]{16,40}$/;

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

function todayAround() { // a submitted date must be within a day of now (time zones), archive days are not counted
  const d = new Date(), f = x => x.toISOString().slice(0, 10);
  return [f(new Date(d - 864e5)), f(d), f(new Date(+d + 864e5))];
}

// ---------- cheap reads: running counters (meta) + short-lived snapshots (snap + isolate memory) ----------
const bump = (env, k, by = 1) => env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v").bind(k, by).run();
async function metaGet(env, keys) { if (!keys.length) return {}; const r = await env.DB.prepare(`SELECT k, v FROM meta WHERE k IN (${keys.map(() => "?").join(",")})`).bind(...keys).all(); const o = {}; for (const x of r.results) o[x.k] = x.v; return o; }
const MEM = new Map();
async function cached(env, key, ttl, compute) { // isolate memory first, then the shared snap row, else recompute
  const now = Date.now(), m = MEM.get(key); if (m && now - m.at < ttl) return m.data;
  const row = await env.DB.prepare("SELECT at, data FROM snap WHERE k = ?").bind(key).first();
  if (row && now - row.at < ttl) { const data = JSON.parse(row.data); MEM.set(key, { at: row.at, data }); return data; }
  const data = await compute();
  MEM.set(key, { at: now, data }); if (MEM.size > 50) MEM.delete(MEM.keys().next().value);
  await env.DB.prepare("INSERT INTO snap (k, at, data) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET at = excluded.at, data = excluded.data").bind(key, now, JSON.stringify(data)).run();
  return data;
}
async function statsBase(env, date) { // one pass over the day's plays; everything else comes from counters
  const rows = await env.DB.prepare("SELECT total, scores FROM plays WHERE date = ?").bind(date).all();
  const b = { n: 0, sum: 0, hist: Array(10).fill(0), tsum: [0, 0, 0, 0, 0], best: null, totals: [] };
  for (const r of rows.results) addPlay(b, r.total, JSON.parse(r.scores));
  const m = await metaGet(env, ["players", "v:" + date]); b.allPlayers = m.players || 0; b.visitors = m["v:" + date] || 0;
  return b;
}
function addPlay(b, total, scores) { b.n++; b.sum += total; b.hist[Math.min(Math.floor(total / 10), 9)]++; scores.forEach((x, i) => b.tsum[i] += Number(x) || 0); b.best = b.best == null ? total : Math.max(b.best, total); b.totals.push(total); }
async function stats(env, date, total, fresh) { // fresh = [total, scores] just inserted, so the player sees themselves counted
  let b = await cached(env, "stats:" + date, 60e3, () => statsBase(env, date));
  if (fresh) { b = structuredClone(b); addPlay(b, fresh[0], fresh[1]); }
  const out = { date, players: b.n, avg: b.n ? Math.round(b.sum / b.n) : 0, hist: b.hist, allPlayers: Math.max(b.allPlayers, b.n), testAvg: b.n ? b.tsum.map(x => Math.round(x / b.n)) : null, best: b.best, visitors: b.visitors };
  if (Number.isInteger(total) && b.n > 0) out.beats = Math.round(b.totals.filter(x => x < total).length / b.n * 100);
  return out;
}

// visitors: counted by our own pings, no third-party analytics
const ONLINE_MS = 5 * 60 * 1000;
const tzDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" }); // YYYY-MM-DD

async function live(env) {
  return cached(env, "live", 30e3, async () => {
    const day = tzDay();
    const on = await env.DB.prepare("SELECT COUNT(DISTINCT client) AS c FROM visits WHERE last > ?").bind(Date.now() - ONLINE_MS).first();
    const m = await metaGet(env, ["v:" + day]);
    return { online: on.c, today: m["v:" + day] || 0, day };
  });
}

async function summary(env, n = 14) { // last n days: visitors and players per day, from the daily counters
  return cached(env, "summary:" + n, 120e3, async () => {
    const dates = []; for (let i = n - 1; i >= 0; i--) dates.push(tzDay(new Date(Date.now() - i * 864e5)));
    const m = await metaGet(env, ["visitors", ...dates.flatMap(d => ["v:" + d, "p:" + d, "s:" + d])]);
    const days = dates.map(d => { const c = m["p:" + d] || 0; return { date: d, visitors: m["v:" + d] || 0, players: c, avg: c ? Math.round((m["s:" + d] || 0) / c) : null }; });
    return { days, allVisitors: m.visitors || 0 };
  });
}


// ---------- Telegram bot: daily reminders + streak ----------
const SITE = "https://sezgir.github.io/";
const LAUNCH = Date.UTC(2026, 10, 12); // #1
const puzzleNo = day => Math.round((Date.parse(day + "T00:00:00Z") - LAUNCH) / 864e5) + 1;
const shiftDay = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const newClient = () => { const a = crypto.getRandomValues(new Uint8Array(24)); return Array.from(a, b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""); };

async function tg(env, method, body) {
  const r = await fetch(`${env.TG_API || "https://api.telegram.org"}/bot${env.TG_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ ok: false }));
}
// style: Telegram's coloured buttons (success = green, primary = blue, danger = red); older apps just show a normal button
const playBtn = (client, label = "🎯 O'ynash") => ({ inline_keyboard: [[{ text: label, style: "success", web_app: { url: `${SITE}?cid=${client}` } }]] });

async function streakOf(env, client) { // consecutive days played, counting today or ending yesterday
  if (!client) return { streak: 0, todayRec: null };
  const today = tzDay();
  const rows = await env.DB.prepare("SELECT date, total FROM plays WHERE client = ? AND date >= ? ORDER BY date DESC").bind(client, shiftDay(today, -400)).all();
  const set = new Map(rows.results.map(r => [r.date, r.total]));
  let d = set.has(today) ? today : shiftDay(today, -1), streak = 0;
  while (set.has(d)) { streak++; d = shiftDay(d, -1); }
  return { streak, todayRec: set.has(today) ? set.get(today) : null };
}

async function onMessage(env, msg) {
  const chat = msg.chat?.id, text = (msg.text || "").trim();
  if (!chat) return;
  if (msg.chat.type === "group" || msg.chat.type === "supergroup") return onGroupMessage(env, msg);
  if (msg.chat.type !== "private") return;
  if (msg.successful_payment) return onPaid(env, msg);
  const name = (msg.from?.first_name || "").slice(0, 40);
  const [cmd, arg] = text.split(/\s+/, 2);
  let u = await env.DB.prepare("SELECT * FROM tg_users WHERE chat_id = ?").bind(chat).first();
  if (cmd === "/baholar" && chat === OWNER_ID) return fbList(env, chat);
  if (cmd === "/statistika" && chat === OWNER_ID) return tg(env, "sendMessage", { chat_id: chat, text: "📊 <b>Statistika paneli</b>", parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📊 Panelni ochish", style: "primary", web_app: { url: `${SITE}admin.html` } }]] } }); // owner wants only the Mini App panel
  if (text && !text.startsWith("/")) { const f = await env.DB.prepare("SELECT * FROM feedback WHERE chat_id = ? AND wait > ?").bind(chat, Date.now() - FB_WAIT).first(); if (f) return fbComment(env, msg, f); }
  if (cmd === "/qollash" || (cmd === "/start" && arg === "qollash")) { const n = cmd === "/qollash" ? parseInt(arg, 10) : 0; return supportMenu(env, chat, n >= 1 && n <= 10000 ? n : 0); }
  if (cmd === "/duel" || (cmd === "/start" && arg === "duel")) return duelPicker(env, chat, chat, null);
  if (cmd === "/start" && /^dg-?\d{1,20}$/.test(arg || "")) { const gid = Number(arg.slice(2)); await autoJoin(env, gid, msg.from); await env.DB.prepare("UPDATE tg_users SET active = 1 WHERE chat_id = ?").bind(chat).run(); return duelPicker(env, chat, chat, gid); }
  if (cmd === "/start" && arg && /^g-?\d{1,20}$/.test(arg)) return joinGroup(env, chat, name, u, Number(arg.slice(1)));
  if (cmd === "/start" && arg && /^v\d{1,5}(_\d{1,3}){5}(_[A-Za-z0-9_-]+)?$/.test(arg)) return openChallenge(env, chat, name, u, arg);
  if (cmd === "/start") {
    const siteClient = arg && CLIENT.test(arg) ? arg : null;
    const client = u?.client || siteClient || newClient();
    if (siteClient && u?.client) await adoptClient(env, siteClient, u.client); // site opened in a browser: its plays join this Telegram user
    await env.DB.prepare("INSERT INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET client = excluded.client, name = excluded.name, active = 1").bind(chat, client, name, Date.now()).run();
    const { streak } = await streakOf(env, client);
    const linked = arg && CLIENT.test(arg) ? `\n\nSaytdagi natijalaringiz ulandi${streak ? `, seriyangiz: ${streak} kun 🔥` : ""}.` : "";
    await tg(env, "sendMessage", { chat_id: chat, text: `Salom${name ? ", " + name : ""}! Men Sezgir botiman.\n\nHar kuni soat 9:00 da yangi jumboq tayyor bo'lganini eslataman. Kechqurun hali o'ynamagan bo'lsangiz, seriyangiz uzilmasligi uchun yana bir marta yozaman.${linked}\n\n/natija — bugungi holatingiz\n/stop — eslatmalarni o'chirish`, reply_markup: playBtn(client) });
    return;
  }
  if (cmd === "/stop") {
    await env.DB.prepare("UPDATE tg_users SET active = 0 WHERE chat_id = ?").bind(chat).run();
    await tg(env, "sendMessage", { chat_id: chat, text: "Eslatmalar o'chirildi. Qayta yoqish uchun /start bosing." });
    return;
  }
  if (!u) { u = { client: newClient() }; await env.DB.prepare("INSERT OR IGNORE INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 1, ?)").bind(chat, u.client, name, Date.now()).run(); }
  if (cmd === "/natija") {
    const day = tzDay(), { streak, todayRec } = await streakOf(env, u.client);
    const agg = await env.DB.prepare("SELECT COUNT(*) AS n, ROUND(AVG(total)) AS avg FROM plays WHERE date = ?").bind(day).first();
    const mine = todayRec != null ? `Bugun ${todayRec} ball oldingiz.` : "Bugun hali o'ynamadingiz.";
    await tg(env, "sendMessage", { chat_id: chat, text: `Sezgir #${puzzleNo(day)}\n${mine}\nSeriya: ${streak} kun${streak ? " 🔥" : ""}\n\nBugun ${agg.n} kishi o'ynadi${agg.n ? `, o'rtacha ball ${agg.avg}` : ""}.`, reply_markup: todayRec == null ? playBtn(u.client) : undefined });
    return;
  }
  await tg(env, "sendMessage", { chat_id: chat, text: "Pastdagi tugma bilan bugungi jumboqni oching.\n\n/natija — bugungi holatingiz\n/qollash — Sezgir'ni qo'llab-quvvatlash\n/stop — eslatmalarni o'chirish", reply_markup: playBtn(u.client) });
}

async function remind(env, evening) {
  const day = tzDay(), no = puzzleNo(day);
  const users = await env.DB.prepare("SELECT chat_id, client FROM tg_users WHERE active = 1").all();
  for (const u of users.results) {
    const { streak, todayRec } = await streakOf(env, u.client);
    let text;
    if (!evening && todayRec != null) continue; // already played after midnight
    if (!evening) text = `☀️ Sezgir #${no} tayyor. Bugungi beshta test sizni kutmoqda.${streak ? `\nSeriyangiz: ${streak} kun 🔥` : ""}${newsOf(day) ? `\n\n${newsOf(day)}` : ""}`;
    else if (todayRec == null && streak > 0) text = `Bugun hali o'ynamadingiz. ${streak} kunlik seriyangiz yarim tunda uziladi 🔥`;
    if (!text) continue;
    const r = await tg(env, "sendMessage", { chat_id: u.chat_id, text: evening ? text : esc(text).replace(/&lt;(\/?b)&gt;/g, "<$1>"), parse_mode: evening ? undefined : "HTML", reply_markup: playBtn(u.client) });
    if (!r.ok && r.error_code === 403) await env.DB.prepare("UPDATE tg_users SET active = 0 WHERE chat_id = ?").bind(u.chat_id).run();
    await new Promise(res => setTimeout(res, 40)); // stay under Telegram's ~30 msg/s
  }
}


// ---------- Support: Telegram Stars donations ----------
const STARS = [5, 10, 20, 50];
const OWNER_ID = 699254555, OWNER = "doniyorjon_k"; // game author: gets a note on each donation
async function invoiceLink(env, stars, anon) {
  const r = await tg(env, "createInvoiceLink", { title: "Sezgir'ni qo'llab-quvvatlash", description: `${stars} ⭐ Sezgir'ga: yangi testlar, server va reklamasiz o'yin uchun. Rahmat!`, payload: `don:${anon ? 1 : 0}`, currency: "XTR", prices: [{ label: "Qo'llab-quvvatlash", amount: stars }] });
  return r.ok ? r.result : null;
}
async function supportMenu(env, chat, n) { // /qollash [N]
  if (n) { const link = await invoiceLink(env, n, false); await tg(env, "sendMessage", { chat_id: chat, text: `${n} ⭐ bilan qo'llab-quvvatlash:`, reply_markup: { inline_keyboard: [[{ text: `⭐ ${n} Stars yuborish`, style: "success", url: link }]] } }); return; }
  const links = await Promise.all(STARS.map(x => invoiceLink(env, x, false)));
  await tg(env, "sendMessage", { chat_id: chat, text: `Sezgir bepul va reklamasiz. Yoqsa, Telegram Stars bilan qo'llab-quvvatlang: yangi testlar va server shu hisobdan bo'ladi 🙏\n\nQo'llab-quvvatlaganlar ismi yonida guruh reytinglarida ⭐ turadi.\nBoshqa miqdor: /qollash 100\nTaklif va savollar: @${OWNER}`, reply_markup: { inline_keyboard: [STARS.slice(0, 2).map((x, i) => ({ text: `⭐ ${x}`, url: links[i] })), STARS.slice(2).map((x, i) => ({ text: `⭐ ${x}`, url: links[i + 2] }))] } });
}
async function onPaid(env, msg) {
  const p = msg.successful_payment; if (p.currency !== "XTR") return;
  const anon = p.invoice_payload === "don:1" ? 1 : 0, name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").slice(0, 40) || "Do'st";
  await env.DB.prepare("INSERT OR IGNORE INTO donations (charge_id, chat_id, name, stars, anon, created) VALUES (?, ?, ?, ?, ?, ?)").bind(p.telegram_payment_charge_id, msg.from.id, name, p.total_amount, anon, Date.now()).run();
  const sum = await env.DB.prepare("SELECT SUM(stars) AS s FROM donations WHERE chat_id = ?").bind(msg.from.id).first();
  if (msg.from.id !== OWNER_ID) await tg(env, "sendMessage", { chat_id: OWNER_ID, text: `💛 Yangi qo'llab-quvvatlash: ${name}${msg.from.username ? ` (@${msg.from.username})` : ""}, ${p.total_amount} ⭐${anon ? " · yashirin" : ""}\nUning jami: ${sum.s} ⭐` });
  await tg(env, "sendMessage", { chat_id: msg.chat.id, text: `Katta rahmat, ${msg.from?.first_name || "do'stim"}! ${p.total_amount} ⭐ qabul qilindi 💛\n\nJami qo'llab-quvvatlovingiz: ${sum.s} ⭐.${anon ? " Ismingiz reytingda ko'rinmaydi." : " Endi guruh reytinglarida ismingiz yonida ⭐ turadi."}` });
}
const ASK_DAYS = 3;
const ASK_TEXT = "🙌 Sezgir bilan 5 kun birga bo‘lganingiz uchun rahmat!\n\nSezgir — bir kishi tomonidan ishlab chiqilgan, bepul va reklamasiz o‘yin. Uni har kuni rivojlantirish, yangi testlar qo‘shish va server xarajatlarini qoplash uchun sizning qo‘llab-quvvatlashingiz katta yordam beradi.\n\nAgar o‘yin sizga yoqayotgan bo‘lsa, uni bir necha ⭐ bilan qo‘llab-quvvatlashingiz mumkin. Har bir yulduz Sezgir’ning yanada rivojlanishiga hissa qo‘shadi.\n\nSezgir muallifi — @doniyorjon_k. O‘yin sizga yoqqan bo‘lsa, unga bildirgan iliq fikringiz yoki oddiygina rahmatingiz ham muallif uchun katta quvonch!\n\nSezgir bilan qolayotganingiz uchun rahmat! ❤️";
async function maybeAskSupport(env, client) { // once per person, after their 5th day of play, unless they already gave Stars
  const u = await env.DB.prepare("SELECT chat_id, client FROM tg_users WHERE client = ? AND active = 1 AND asked = 0").bind(client).first(); if (!u) return;
  const d = await env.DB.prepare("SELECT COUNT(DISTINCT date) AS n FROM plays WHERE client = ?").bind(client).first(); if (d.n < ASK_DAYS) return;
  const given = await env.DB.prepare("SELECT 1 FROM donations WHERE chat_id = ? LIMIT 1").bind(u.chat_id).first();
  const claim = await env.DB.prepare("UPDATE tg_users SET asked = 1 WHERE chat_id = ? AND asked = 0").bind(u.chat_id).run(); if (!claim.meta?.changes || given) return;
  const links = await Promise.all(STARS.map(x => invoiceLink(env, x, false)));
  await tg(env, "sendMessage", { chat_id: u.chat_id, text: ASK_TEXT, reply_markup: askButtons(u.client, links) });
}
// ---------- owner dashboard data (admin.html in the Mini App): only for OWNER_ID, checked via fresh Telegram initData ----------
async function adminStats(env, initData) {
  const u = await tgUser(env, initData);
  const fresh = Number(new URLSearchParams(initData || "").get("auth_date") || 0) > Date.now() / 1000 - 86400;
  if (!u || u.id !== OWNER_ID || !fresh) return null;
  const all = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  // raw tables; the panel builds every view (players, days, groups, duels) itself
  const [users, plays, groups, members, duels, elo, feedback, visits] = await Promise.all([
    all("SELECT chat_id, client, name, active, created FROM tg_users"),
    all("SELECT date, client, total, scores, created FROM plays ORDER BY date"),
    all("SELECT chat_id, title, active, created FROM tg_groups"),
    all("SELECT group_id, user_id, joined FROM tg_members"),
    all("SELECT id, gid, a, b, status, day, created, accepted, a_start, b_start, a_score, b_score, a_scores, b_scores, delta FROM duels ORDER BY created DESC"),
    all("SELECT chat_id, elo, w, l, d FROM duel_elo"),
    all("SELECT chat_id, name, username, stars, comment, asked, rated, commented FROM feedback"),
    all("SELECT date, COUNT(*) AS n FROM visits GROUP BY date"),
  ]);
  return { day: tzDay(), now: Date.now(), tests: TEST_NAMES, users, plays, groups, members, duels, elo, feedback, visits };
}
// ---------- /statistika: owner-only overview of players and plays ----------
const TEST_NAMES = ["Anor", "Chillak", "Minora", "Ketmon", "Non"];
const dayLabel = d => { const [, m, dd] = d.split("-").map(Number); return `${dd}-${["yan","fev","mar","apr","may","iyun","iyul","avg","sen","okt","noy","dek"][m - 1]}`; };
async function sendChunks(env, chat, head, lines) { // Telegram caps a message at 4096 chars
  let buf = head; for (const l of lines) { if (buf.length + l.length + 1 > 3900) { await tg(env, "sendMessage", { chat_id: chat, text: buf, parse_mode: "HTML" }); buf = ""; } buf += (buf ? "\n" : "") + l; }
  if (buf) await tg(env, "sendMessage", { chat_id: chat, text: buf, parse_mode: "HTML" });
}
async function statList(env, chat) {
  const day = tzDay(), yday = shiftDay(day, -1), q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const t = await q(`SELECT (SELECT COUNT(DISTINCT client) FROM plays) AS players, (SELECT COUNT(*) FROM plays) AS plays, (SELECT ROUND(AVG(total)) FROM plays) AS avg,
    (SELECT COUNT(*) FROM tg_users) AS bot, (SELECT COUNT(*) FROM tg_users WHERE active = 1) AS botOn,
    (SELECT COUNT(DISTINCT p.client) FROM plays p JOIN tg_users u ON u.client = p.client) AS tgPlayers,
    (SELECT COUNT(*) FROM tg_groups WHERE active = 1) AS groups, (SELECT COUNT(DISTINCT user_id) FROM tg_members m JOIN tg_groups g ON g.chat_id = m.group_id AND g.active = 1) AS members,
    (SELECT COUNT(*) FROM (SELECT client FROM plays GROUP BY client HAVING COUNT(*) >= 2)) AS ret2, (SELECT COUNT(*) FROM (SELECT client FROM plays GROUP BY client HAVING COUNT(*) >= 5)) AS ret5,
    (SELECT COUNT(*) FROM duels WHERE status = 'done') AS duels, (SELECT COUNT(*) FROM duels WHERE status IN ('pending','active')) AS duelsOpen,
    (SELECT COUNT(stars) FROM feedback) AS rated, (SELECT ROUND(AVG(stars), 1) FROM feedback) AS stars`).first();
  const days = (await q(`SELECT d.date, d.n, d.avg, (SELECT COUNT(*) FROM visits v WHERE v.date = d.date) AS vis, (SELECT COUNT(*) FROM plays p2 WHERE p2.date = d.date AND NOT EXISTS (SELECT 1 FROM plays p3 WHERE p3.client = p2.client AND p3.date < d.date)) AS fresh
    FROM (SELECT date, COUNT(*) AS n, ROUND(AVG(total)) AS avg FROM plays GROUP BY date ORDER BY date DESC LIMIT 7) d ORDER BY d.date DESC`).all()).results;
  const today = (await q("SELECT scores FROM plays WHERE date = ?", day).all()).results.map(r => JSON.parse(r.scores));
  const testAvg = today.length ? TEST_NAMES.map((n, i) => `${n} ${Math.round(today.reduce((a, s) => a + (Number(s[i]) || 0), 0) / today.length)}`).join(" · ") : "";
  const tdy = days.find(d => d.date === day), ydy = days.find(d => d.date === yday);
  const L = [`<b>📊 Sezgir statistikasi</b> · ${dayLabel(day)}`, "",
    `<b>O'yinchilar: ${t.players}</b> (Telegram orqali ${t.tgPlayers} · faqat saytda ${t.players - t.tgPlayers})`,
    `Qaytib o'ynaganlar: 2+ kun ${t.ret2} · 5+ kun ${t.ret5}`,
    `Bot: ${t.bot} kishi, eslatma yoqilgan ${t.botOn}`,
    `Guruhlar: ${t.groups} ta, bellashuvda ${t.members} kishi`,
    `Jami o'yinlar: ${t.plays} · o'rtacha ball ${t.avg ?? "–"}`, "",
    `<b>Bugun: ${tdy ? tdy.n : 0} o'yin</b>${tdy ? ` · o'rtacha ${tdy.avg} · yangi ${tdy.fresh} · saytga kirgan ${tdy.vis}` : ""}`,
    testAvg ? `Testlar (o'rtacha): ${testAvg}` : "",
    `Kecha: ${ydy ? `${ydy.n} o'yin · o'rtacha ${ydy.avg}` : "0 o'yin"}`, "",
    `<b>Oxirgi kunlar</b> (o'yin · yangi · tashrif):`, ...days.map(d => `${dayLabel(d.date)}: ${d.n} · ${d.fresh} · ${d.vis}`), "",
    `Duellar: ${t.duels} ta tugagan, ${t.duelsOpen} ta ochiq`,
    `Baholar: ${t.rated ? `${t.stars} / 5 (${t.rated} kishi)` : "hali yo'q"} · /baholar`].filter((l, i, a) => l !== "" || a[i - 1] !== "");
  await tg(env, "sendMessage", { chat_id: chat, text: L.join("\n"), parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📊 Batafsil panel", style: "primary", web_app: { url: `${SITE}admin.html` } }]] } });
  const rows = (await q(`SELECT p.client, COUNT(*) AS n, ROUND(AVG(p.total)) AS avg, MAX(p.total) AS best, MAX(p.date) AS last, MIN(p.date) AS first, u.name
    FROM plays p LEFT JOIN tg_users u ON u.client = p.client GROUP BY p.client ORDER BY n DESC, last DESC`).all()).results;
  await sendChunks(env, chat, `<b>👥 O'yinchilar (${rows.length})</b> · kun · o'rtacha · eng yaxshi · oxirgi`,
    rows.map((r, i) => `${i + 1}. ${r.name ? esc(r.name) : `<i>saytdan ${r.client.slice(0, 5)}</i>`} — ${r.n} kun · ${r.avg} · ${r.best} · ${r.last === day ? "bugun" : dayLabel(r.last)}`));
}
// ---------- ratings: after a player's first game the bot asks for 1-5 stars and an optional comment; the owner sees them in /baholar ----------
const FB_ON = true; // owner approved 2026-11-21
const FB_DAYS = 1, FB_WAIT = 48 * 36e5;
const starsOf = n => "★".repeat(n) + "☆".repeat(5 - n);
const FB_ASK = "<b>Sezgir sizga ma'qul keldimi?</b>\n\nSezgir'ni o'ynaganingiz uchun rahmat! O'yinni <b>1 dan 5 gacha</b> yulduz bilan baholang:";
const fbButtons = () => ({ inline_keyboard: [[1, 2, 3, 4, 5].map(n => ({ text: `${n} ⭐`, callback_data: `fb:${n}` }))] });
async function fbAsk(env, chat, name) {
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO feedback (chat_id, name, asked) VALUES (?, ?, ?)").bind(chat, name || null, Date.now()).run();
  if (!claim.meta?.changes) return false; // asked before
  const r = await tg(env, "sendMessage", { chat_id: chat, text: FB_ASK, parse_mode: "HTML", reply_markup: fbButtons() });
  return !!r.ok;
}
async function maybeAskFeedback(env, client) { if (!FB_ON) return;
  const u = await env.DB.prepare("SELECT u.chat_id, u.name FROM tg_users u LEFT JOIN feedback f ON f.chat_id = u.chat_id WHERE u.client = ? AND u.active = 1 AND f.chat_id IS NULL").bind(client).first(); if (!u) return;
  const d = await env.DB.prepare("SELECT COUNT(DISTINCT date) AS n FROM plays WHERE client = ?").bind(client).first(); if (d.n < FB_DAYS) return;
  await fbAsk(env, u.chat_id, u.name);
}
const FB_SKIP = { inline_keyboard: [[{ text: "Yozadigan narsam yo'q", callback_data: "fb:skip" }]] };
const FB_COMMENT = n => `<b>Taklif, shikoyat yoki e'tirozingiz bormi?</b>\n\n${n <= 3 ? "Nima yoqmaganini yozsangiz, tuzatishga harakat qilamiz." : "Nima yoqdi, nimani yaxshilash kerak?"} <b>Shu yerga yozib yuboring</b>, har bir fikrni muallif o'zi o'qiydi.`;
const FB_NUDGE_AFTER = 4 * 36e5;
async function fbRemind(env) { // one gentle reminder to players who rated but wrote nothing
  const hr = (new Date().getUTCHours() + 5) % 24; if (hr >= 23 || hr < 9) return;
  const now = Date.now();
  const rows = (await env.DB.prepare("SELECT chat_id, stars FROM feedback WHERE stars IS NOT NULL AND comment IS NULL AND nudged = 0 AND wait > 0 AND wait < ? AND wait > ?").bind(now - FB_NUDGE_AFTER, now - FB_WAIT).all()).results;
  for (const f of rows) {
    const claim = await env.DB.prepare("UPDATE feedback SET nudged = 1, wait = ? WHERE chat_id = ? AND nudged = 0").bind(now, f.chat_id).run(); if (!claim.meta?.changes) continue;
    await tg(env, "sendMessage", { chat_id: f.chat_id, parse_mode: "HTML", reply_markup: FB_SKIP,
      text: `<b>Fikringizni kutyapmiz 🙂</b>\n\nSezgir'ga ${starsOf(f.stars)} baho qo'yganingiz uchun rahmat! ${f.stars <= 3 ? "Nima yoqmadi, nimani o'zgartirsak bo'ladi?" : "Nima yoqdi, nimani yaxshilash kerak?"} <b>Bir-ikki so'z bo'lsa ham shu yerga yozib yuboring</b>.` });
    await new Promise(res => setTimeout(res, 40));
  }
}
const who = f => `${esc(f.name || "O'yinchi")}${f.username ? ` (@${esc(f.username)})` : ""}`;
async function fbRate(env, q, from, v) {
  const f = await env.DB.prepare("SELECT * FROM feedback WHERE chat_id = ?").bind(from).first();
  if (!f) return answerCb(env, q, "");
  const chat = q.message?.chat?.id, mid = q.message?.message_id;
  if (v === "skip") {
    await env.DB.prepare("UPDATE feedback SET wait = 0 WHERE chat_id = ?").bind(from).run(); await answerCb(env, q, "");
    if (chat) await tg(env, "editMessageText", { chat_id: chat, message_id: mid, text: `<b>Bahoyingiz: ${starsOf(f.stars || 0)} (${f.stars || 0}/5)</b>\n\nRahmat! Ertangi jumboqda ko'rishguncha 👋`, parse_mode: "HTML" });
    return;
  }
  const n = Number(v); if (!(n >= 1 && n <= 5)) return answerCb(env, q, "");
  const name = [q.from.first_name, q.from.last_name].filter(Boolean).join(" ").slice(0, 60) || f.name;
  await env.DB.prepare("UPDATE feedback SET stars = ?, rated = ?, wait = ?, name = ?, username = ? WHERE chat_id = ?").bind(n, Date.now(), Date.now(), name, q.from.username || null, from).run();
  await answerCb(env, q, "Rahmat! ⭐");
  if (chat) { // keep the rating message short and ask for a comment in a new message, so the phone notifies the player
    await tg(env, "editMessageText", { chat_id: chat, message_id: mid, parse_mode: "HTML", text: `<b>Bahoyingiz: ${starsOf(n)} (${n}/5)</b>\n\nRahmat! ⭐` });
    await tg(env, "sendMessage", { chat_id: chat, parse_mode: "HTML", text: FB_COMMENT(n), reply_markup: FB_SKIP });
  }
  await tg(env, "sendMessage", { chat_id: OWNER_ID, parse_mode: "HTML", text: `⭐ <b>Yangi baho:</b> ${who({ name, username: q.from.username })} · ${starsOf(n)} ${n}/5${f.stars != null && f.stars !== n ? ` (avval ${f.stars}/5)` : ""}` });
}
async function fbComment(env, msg, f) { // the next private text after rating
  const text = String(msg.text).slice(0, 2000), now = Date.now();
  await env.DB.prepare("UPDATE feedback SET comment = CASE WHEN comment IS NULL THEN ? ELSE comment || char(10) || '—' || char(10) || ? END, commented = ?, wait = 0 WHERE chat_id = ?").bind(text, text, now, f.chat_id).run();
  await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "<b>Rahmat! Fikringiz muallifga yetkazildi 🙏</b>", parse_mode: "HTML" });
  await tg(env, "sendMessage", { chat_id: OWNER_ID, parse_mode: "HTML", text: `💬 <b>Yangi izoh:</b> ${who(f)} · ${starsOf(f.stars || 0)} ${f.stars || 0}/5\n\n${esc(text)}` });
}
const fmtTime = t => { const d = new Date(t + 5 * 36e5); return `${d.getUTCDate()}-${["yan","fev","mar","apr","may","iyun","iyul","avg","sen","okt","noy","dek"][d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
async function fbList(env, chat) {
  const all = await env.DB.prepare("SELECT COUNT(*) AS asked, COUNT(stars) AS n, AVG(stars) AS avg, SUM(stars = 5) AS s5, SUM(stars = 4) AS s4, SUM(stars = 3) AS s3, SUM(stars = 2) AS s2, SUM(stars = 1) AS s1, COUNT(comment) AS c FROM feedback").first();
  const rows = (await env.DB.prepare("SELECT * FROM feedback WHERE stars IS NOT NULL ORDER BY COALESCE(commented, rated) DESC LIMIT 15").all()).results;
  let text = `<b>⭐ Baholar</b>\n\nSo'ralgan: ${all.asked} kishi · baholagan: <b>${all.n}</b> · izoh yozgan: ${all.c}` + (all.n ? `\nO'rtacha: <b>${(all.avg).toFixed(1)} / 5</b>\n5★ ${all.s5} · 4★ ${all.s4} · 3★ ${all.s3} · 2★ ${all.s2} · 1★ ${all.s1}` : "");
  if (rows.length) text += "\n\n<b>Oxirgilari:</b>";
  for (const f of rows) { const add = `\n\n${starsOf(f.stars)} ${who(f)} · ${fmtTime(f.commented || f.rated)}${f.comment ? `\n<i>${esc(f.comment.length > 300 ? f.comment.slice(0, 300) + "…" : f.comment)}</i>` : ""}`; if (text.length + add.length > 3900) break; text += add; }
  await tg(env, "sendMessage", { chat_id: chat, text, parse_mode: "HTML" });
}
const askButtons = (client, links) => ({ inline_keyboard: [STARS.map((x, i) => ({ text: `⭐ ${x}`, url: links[i] })), [{ text: "Boshqa miqdor", web_app: { url: `${SITE}?cid=${client}&qollab=1` } }]] });
async function supporters(env) {
  const top = await env.DB.prepare("SELECT chat_id, MAX(anon) AS anon, MAX(name) AS name, SUM(stars) AS stars, MAX(created) AS last FROM donations GROUP BY chat_id ORDER BY stars DESC, last ASC LIMIT 10").all();
  const agg = await env.DB.prepare("SELECT COUNT(DISTINCT chat_id) AS people, COALESCE(SUM(stars), 0) AS stars FROM donations").first();
  return { people: agg.people, stars: agg.stars, top: top.results.map(r => ({ name: r.anon ? null : r.name, stars: r.stars })) };
}

// ---------- Telegram groups: shared daily leaderboard ----------
const BOT_USER = "sezgiruz_bot";
const gradeOf = s => s >= 95 ? "A+" : s >= 88 ? "A" : s >= 80 ? "B+" : s >= 70 ? "B" : s >= 62 ? "C+" : s >= 55 ? "C" : s >= 40 ? "D" : "F";
const joinBtn = gid => ({ inline_keyboard: [[{ text: "🏆 Qatnashish", style: "primary", url: `https://t.me/${BOT_USER}?start=g${gid}` }]] });
const MEDALS = ["🥇", "🥈", "🥉"];

async function groupBoard(env, gid, day) { // members who played `day`, best first; plus members who did not
  const rows = await env.DB.prepare("SELECT u.chat_id, u.name, p.total, p.created, EXISTS(SELECT 1 FROM donations d WHERE d.chat_id = u.chat_id AND d.anon = 0) AS sup FROM tg_members m JOIN tg_users u ON u.chat_id = m.user_id LEFT JOIN plays p ON p.client = u.client AND p.date = ? WHERE m.group_id = ?").bind(day, gid).all();
  const played = rows.results.filter(r => r.total != null).sort((a, b) => b.total - a.total || a.created - b.created);
  const idle = rows.results.filter(r => r.total == null);
  return { played, idle, members: rows.results.length };
}
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const boardLines = played => played.map((r, i) => `${MEDALS[i] || `${i + 1}.`} ${r.name || "O'yinchi"}${r.sup ? " ⭐" : ""}, ${gradeOf(r.total)} · ${r.total}`);
function boardText(title, day, b) { // HTML (parse_mode): title and closing line bold, names escaped
  if (!b.played.length) return null;
  const lines = boardLines(b.played).map(esc);
  const idle = b.idle.length ? `\n\n<b>Hali o'ynamaganlar: ${esc(b.idle.map(r => r.name || "O'yinchi").join(", "))} 👀</b>` : "";
  return `<b>${esc(title)}</b>\n\n${lines.join("\n")}${idle}`;
}

async function joinGroup(env, chat, name, u, gid) {
  const g = await env.DB.prepare("SELECT * FROM tg_groups WHERE chat_id = ? AND active = 1").bind(gid).first();
  if (!g) { await tg(env, "sendMessage", { chat_id: chat, text: "Bu guruh topilmadi. Botni guruhga qayta qo'shib ko'ring." }); return; }
  const client = u?.client || newClient();
  await env.DB.prepare("INSERT INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name").bind(chat, client, name, Date.now()).run();
  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO tg_members (group_id, user_id, joined) VALUES (?, ?, ?)").bind(gid, chat, Date.now()).run();
  await tg(env, "sendMessage", { chat_id: chat, text: `Siz «${g.title}» guruhi bellashuviga qo'shildingiz ✅\n\nO'ynaganingizdan keyin natijangiz guruhda ko'rinadi. Har kuni 21:00 da bot guruhga kunlik reytingni yozadi.\n\nMuhim: natija hisobga olinishi uchun pastdagi tugma orqali o'ynang.`, reply_markup: playBtn(client) });
  if (fresh.meta?.changes) await tg(env, "sendMessage", { chat_id: gid, text: `${name || "Yangi o'yinchi"} bellashuvga qo'shildi 👋` });
}

function unb64url(b) { try { const bin = atob(b.replace(/-/g, "+").replace(/_/g, "/")); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))).replace(/[<>]/g, "").trim().slice(0, 24); } catch { return ""; } }
async function openChallenge(env, chat, name, u, arg) { // friend's link shared from inside Telegram: t.me/<bot>?start=v<no>_<s1..s5>_<name>
  const parts = arg.slice(1).split("_"), no = Number(parts[0]), scores = parts.slice(1, 6).map(Number), who = unb64url(parts.slice(6).join("_")) || "Do'stingiz";
  const client = u?.client || newClient();
  await env.DB.prepare("INSERT INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, active = 1").bind(chat, client, name, Date.now()).run();
  const today = puzzleNo(tzDay());
  if (no !== today || scores.some(x => x > 100)) { await tg(env, "sendMessage", { chat_id: chat, text: `Bu chaqiruv eski (#${no}). Bugungi Sezgir #${today}ni o'ynab ko'ring!`, reply_markup: playBtn(client) }); return; }
  const total = Math.round(scores.reduce((a, b) => a + b, 0) / 5);
  const url = `${SITE}?cid=${client}&vs=${[no, ...scores].join(".")}&n=${encodeURIComponent(who)}`;
  await tg(env, "sendMessage", { chat_id: chat, text: `${who} sizni Sezgir'ga chaqirdi 🎯\n\nBugun u ${gradeOf(total)} · ${total} ball oldi. Undan o'ta olasizmi? O'ynab bo'lgach natijalaringiz yonma-yon chiqadi.\n\nHar kuni 9:00 da yangi jumboq haqida eslatib turaman (/stop bilan o'chiriladi).`, reply_markup: { inline_keyboard: [[{ text: "🎯 Qabul qilaman", style: "success", web_app: { url } }]] } });
}

async function onGroupMessage(env, msg) {
  const gid = msg.chat.id, text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(`@${BOT_USER}`, "");
  if (msg.migrate_to_chat_id) { await env.DB.prepare("UPDATE tg_groups SET chat_id = ? WHERE chat_id = ?").bind(msg.migrate_to_chat_id, gid).run(); await env.DB.prepare("UPDATE tg_members SET group_id = ? WHERE group_id = ?").bind(msg.migrate_to_chat_id, gid).run(); return; }
  if (!cmd.startsWith("/")) return;
  await env.DB.prepare("INSERT INTO tg_groups (chat_id, title, active, created) VALUES (?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, active = 1").bind(gid, (msg.chat.title || "Guruh").slice(0, 60), Date.now()).run();
  if (msg.from && cmd !== "/qatnashish") await autoJoin(env, gid, msg.from);
  if (cmd === "/reyting") {
    const day = tzDay(), b = await groupBoard(env, gid, day);
    const t = boardText(`Sezgir #${puzzleNo(day)} · bugungi reyting`, day, b);
    await tg(env, "sendMessage", { chat_id: gid, text: t || (b.members ? "Bugun hali hech kim o'ynamadi. Birinchi bo'ling!" : "Reytingda hali hech kim yo'q. Qatnashish uchun tugmani bosing."), parse_mode: "HTML", reply_markup: joinBtn(gid) });
    return;
  }
  if (cmd === "/duel") return duelPicker(env, gid, msg.from?.id, gid);
  if (cmd === "/duelreyting") return duelBoard(env, gid);
  if (cmd === "/qatnashish") await tg(env, "sendMessage", { chat_id: gid, text: "Guruh bellashuviga qo'shilish uchun tugmani bosing. Bot sizga shaxsiy xabarda o'yin havolasini yuboradi.", reply_markup: joinBtn(gid) });
}

async function onMyChatMember(env, upd) {
  const chat = upd.chat; if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const st = upd.new_chat_member?.status;
  if (st === "member" || st === "administrator") {
    await env.DB.prepare("INSERT INTO tg_groups (chat_id, title, active, created) VALUES (?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, active = 1").bind(chat.id, (chat.title || "Guruh").slice(0, 60), Date.now()).run();
    const by = upd.from; let adder = "";
    if (by && !by.is_bot) { // whoever added the bot joins the group board right away
      const name = (by.first_name || "").slice(0, 40), u = await env.DB.prepare("SELECT client FROM tg_users WHERE chat_id = ?").bind(by.id).first();
      await env.DB.prepare("INSERT INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 0, ?) ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name").bind(by.id, u?.client || newClient(), name, Date.now()).run();
      await env.DB.prepare("INSERT OR IGNORE INTO tg_members (group_id, user_id, joined) VALUES (?, ?, ?)").bind(chat.id, by.id, Date.now()).run();
      adder = name; }
    if (upd.old_chat_member?.status === "left" || upd.old_chat_member?.status === "kicked")
      await tg(env, "sendMessage", { chat_id: chat.id, text: `Salom, «${chat.title || "guruh"}»! Men Sezgir botiman 👋\n\nHar kuni 5 ta qisqa idrok testi. Kim o'ynasa, natijasini shu yerga yozaman, 21:00 da esa kunlik reytingni chiqaraman. Yakshanba kuni haftaning g'olibini e'lon qilaman.\n\n${adder ? `${adder} bellashuvga qo'shildi. ` : ""}Qatnashish uchun pastdagi tugmani bosing.\n/reyting — bugungi reyting`, reply_markup: joinBtn(chat.id) });
  } else if (st === "left" || st === "kicked") await env.DB.prepare("UPDATE tg_groups SET active = 0 WHERE chat_id = ?").bind(chat.id).run();
}

async function announcePlay(env, client, date, total) { // "Aziz o'ynadi" in each of the player's groups
  if (!env.TG_BOT_TOKEN || date !== tzDay()) return;
  const rows = await env.DB.prepare("SELECT g.chat_id AS gid, u.name, u.chat_id AS uid FROM tg_users u JOIN tg_members m ON m.user_id = u.chat_id JOIN tg_groups g ON g.chat_id = m.group_id AND g.active = 1 WHERE u.client = ?").bind(client).all();
  for (const r of rows.results) {
    const b = await groupBoard(env, r.gid, date); const rank = b.played.findIndex(p => p.chat_id === r.uid) + 1;
    await tg(env, "sendMessage", { chat_id: r.gid, text: `${r.name || "O'yinchi"} o'ynadi: ${gradeOf(total)} · ${total} ball${rank ? ` (hozircha ${rank}-o'rin, ${b.played.length} kishidan)` : ""}`, reply_markup: { inline_keyboard: [[{ text: "🎯 O'ynash", style: "success", url: `https://t.me/${BOT_USER}?startapp=g${r.gid}` }]] } });
  }
}

// one-off news line for the 09:00 messages, keyed by day (HTML; bold parts in <b>)
const NEWS = { "2026-11-21": "🆕 <b>Yangi test: Ketmon!</b> Doira o'rniga endi burchak sezgisi bor: burchak 1,5 soniya ko'rinadi, keyin uni xotiradan yasaysiz. <b>Kim aniqroq topar ekan?</b>" };
const newsOf = day => NEWS[day] || "";
// One-off group announcement (owner-approved). Sent once by the hourly cron after `at`, only to groups whose title matches.
const PROMO = {
  key: "promo:games-2026-11", at: Date.parse("2026-11-24T18:00:00Z"), // owner chose "send now" (23:2x Tashkent)
  match: /синфдош|sinfdosh/i,
  text: "🎮 <b>Sezgirda yangi o'yinlar!</b>\nKunlik testdan tashqari endi 2 ta o'yin bor:\n🏎 <b>Chaqmoq</b>: 3D mashina poygasi. 5 ta botni quvib o'ting, nitroni bosing va 3 aylanada birinchi bo'ling.\n🎯 <b>Pistirma</b>: tungi otishma, botlarga qarshi.\nTelefonda ham, kompyuterda ham ishlaydi. Kim birinchi bo'lib Chaqmoqni \"Qiyin\" darajada yutar ekan? 😉",
  buttons: [[{ text: "🏎 Chaqmoq", style: "success", url: `https://t.me/${BOT_USER}?startapp=chaqmoq` }, { text: "🎯 Pistirma", style: "primary", url: `https://t.me/${BOT_USER}?startapp=pistirma` }]],
};
async function sendPromo(env) {
  if (Date.now() < PROMO.at) return;
  if (await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(PROMO.key).first()) return;
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, 1) ON CONFLICT(k) DO NOTHING").bind(PROMO.key).run(); // mark first: never send twice
  const { results } = await env.DB.prepare("SELECT chat_id, title FROM tg_groups WHERE active = 1").all();
  for (const g of results.filter((g) => PROMO.match.test(g.title || "")))
    await tg(env, "sendMessage", { chat_id: g.chat_id, text: PROMO.text, parse_mode: "HTML", reply_markup: { inline_keyboard: PROMO.buttons } }).catch(() => {});
}

async function morningGroups(env) { // 09:00 Tashkent: short "new puzzle" note in each group, with yesterday's winner
  const day = tzDay(), yday = shiftDay(day, -1);
  const groups = await env.DB.prepare("SELECT chat_id FROM tg_groups WHERE active = 1").all();
  for (const g of groups.results) {
    const w = (await groupBoard(env, g.chat_id, yday)).played[0], b = await groupBoard(env, g.chat_id, day);
    const news = newsOf(day) ? `\n\n${newsOf(day)}` : "";
    const yest = w ? `Kechagi g'olib: 🥇 ${esc(w.name || "O'yinchi")}, ${gradeOf(w.total)} · ${w.total}` : ""; // HTML message: names escaped, key lines bold
    const text = b.played.length // some already played after midnight: show the board so far
      ? `<b>☀️ Sezgir #${puzzleNo(day)} · hozirgi reyting</b>${news}\n\n${boardLines(b.played.slice(0, 10)).map(esc).join("\n")}${b.played.length > 10 ? `\n… yana ${b.played.length - 10} kishi` : ""}\n\n<b>${b.idle.length ? `Hali o'ynamaganlar: ${b.idle.length} kishi. Kim o'zib ketadi?` : "Hamma o'ynadi!"}</b>${yest ? `\n\n${yest}` : ""}`
      : `<b>☀️ Sezgir #${puzzleNo(day)} tayyor. Bugun kim birinchi bo'ladi?</b>${news}${yest ? `\n\n${yest}` : ""}`;
    const r = await tg(env, "sendMessage", { chat_id: g.chat_id, text, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🎯 O'ynash", style: "success", url: `https://t.me/${BOT_USER}?startapp=g${g.chat_id}` }]] } });
    if (!r.ok && (r.error_code === 403 || r.error_code === 400)) await env.DB.prepare("UPDATE tg_groups SET active = 0 WHERE chat_id = ?").bind(g.chat_id).run();
    await new Promise(res => setTimeout(res, 40));
  }
}
async function postBoards(env) { // 21:00 Tashkent: daily board; on Sunday also the week's winner
  const day = tzDay(), sunday = new Date(day + "T12:00:00Z").getUTCDay() === 0;
  const groups = await env.DB.prepare("SELECT chat_id, title FROM tg_groups WHERE active = 1").all();
  for (const g of groups.results) {
    const b = await groupBoard(env, g.chat_id, day);
    const t = boardText(`Sezgir #${puzzleNo(day)} · kun yakuni`, day, b);
    if (t) { const r = await tg(env, "sendMessage", { chat_id: g.chat_id, text: t + "\n\n<b>Ertaga 9:00 da yangi jumboq.</b>", parse_mode: "HTML", reply_markup: joinBtn(g.chat_id) }); if (!r.ok && (r.error_code === 403 || r.error_code === 400)) { await env.DB.prepare("UPDATE tg_groups SET active = 0 WHERE chat_id = ?").bind(g.chat_id).run(); continue; } }
    if (sunday) {
      const from = shiftDay(day, -6);
      const w = await env.DB.prepare("SELECT u.name, SUM(p.total) AS sum, COUNT(*) AS days FROM tg_members m JOIN tg_users u ON u.chat_id = m.user_id JOIN plays p ON p.client = u.client AND p.date BETWEEN ? AND ? WHERE m.group_id = ? GROUP BY u.chat_id ORDER BY sum DESC LIMIT 5").bind(from, day, g.chat_id).all();
      if (w.results.length) await tg(env, "sendMessage", { chat_id: g.chat_id, text: `<b>🏆 Haftaning g'olibi: ${esc(w.results[0].name || "O'yinchi")}!</b>\n\n${w.results.map((r, i) => `${MEDALS[i] || `${i + 1}.`} ${esc(r.name || "O'yinchi")}: ${r.sum} ball (${r.days} kun)`).join("\n")}\n\n<b>Haftalik hisob: 7 kunlik ballar yig'indisi, shuning uchun har kuni o'ynash muhim.</b>`, parse_mode: "HTML" });
    }
    await new Promise(res => setTimeout(res, 50));
  }
}

async function myGroups(env, client, date) { // for the site: "guruhingizda N-o'rindasiz"
  const rows = await env.DB.prepare("SELECT g.chat_id AS gid, g.title, u.chat_id AS uid FROM tg_users u JOIN tg_members m ON m.user_id = u.chat_id JOIN tg_groups g ON g.chat_id = m.group_id AND g.active = 1 WHERE u.client = ?").bind(client).all();
  const out = [];
  for (const r of rows.results.slice(0, 5)) { const b = await groupBoard(env, r.gid, date); const i = b.played.findIndex(p => p.chat_id === r.uid); out.push({ title: r.title, rank: i >= 0 ? i + 1 : null, played: b.played.length, members: b.members, leader: b.played[0] ? { name: b.played[0].name, total: b.played[0].total } : null }); }
  return out;
}

async function tgSetup(env, origin) {
  const hook = await tg(env, "setWebhook", { url: `${origin}/tg/hook`, secret_token: env.TG_WEBHOOK_SECRET, allowed_updates: ["message", "my_chat_member", "pre_checkout_query", "callback_query"], drop_pending_updates: true });
  const cmds = await tg(env, "setMyCommands", { commands: [{ command: "start", description: "Eslatmalarni yoqish" }, { command: "natija", description: "Bugungi holatim va seriya" }, { command: "duel", description: "Do'stni duelga chaqirish ⚔️" }, { command: "qollash", description: "Sezgir'ni qo'llab-quvvatlash ⭐" }, { command: "stop", description: "Eslatmalarni o'chirish" }] });
  await tg(env, "setMyCommands", { scope: { type: "chat", chat_id: OWNER_ID }, commands: [{ command: "start", description: "Eslatmalarni yoqish" }, { command: "natija", description: "Bugungi holatim va seriya" }, { command: "duel", description: "Do'stni duelga chaqirish ⚔️" }, { command: "statistika", description: "To'liq statistika 📊" }, { command: "baholar", description: "O'yinchilar baholari va izohlari" }, { command: "qollash", description: "Sezgir'ni qo'llab-quvvatlash ⭐" }, { command: "stop", description: "Eslatmalarni o'chirish" }] });
  await tg(env, "setMyCommands", { scope: { type: "all_group_chats" }, commands: [{ command: "reyting", description: "Bugungi guruh reytingi" }, { command: "qatnashish", description: "Bellashuvga qo'shilish" }, { command: "duel", description: "Duelga chaqirish ⚔️" }, { command: "duelreyting", description: "Duel reytingi" }] });
  const menu = await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "O'ynash", web_app: { url: SITE } } });
  const desc = await tg(env, "setMyDescription", { description: "Sezgir: har kuni 5 ta qisqa idrok testi, 2 daqiqa. Bot har kuni ertalab yangi jumboqni eslatadi va seriyangizni sanaydi." });
  const sdesc = await tg(env, "setMyShortDescription", { short_description: "Ko'zingiz qanchalik aniq? Har kuni 5 ta test." });
  const me = await tg(env, "getMe", {}), owner = await tg(env, "getChat", { chat_id: OWNER_ID });
  return { owner: owner.result?.username === OWNER, hook: hook.ok, cmds: cmds.ok, menu: menu.ok, desc: desc.ok && sdesc.ok, username: me.result?.username };
}

// ---------- Duel: pick a groupmate, they accept, both play one random puzzle made for this duel only ----------
// Separate Elo-style rating (start 1000), the daily board is untouched. One duel per pair per day.
const DUEL_TTL = 24 * 3600e3, ELO_K = 32;
const rid = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
const nm = r => (r && r.name) || "O'yinchi";
const duelBtn = (id, client) => ({ inline_keyboard: [[{ text: "⚔️ Duelni boshlash", style: "success", web_app: { url: `${SITE}?duel=${id}&cid=${client}` } }]] });
async function duelUser(env, chat) { return env.DB.prepare("SELECT chat_id, client, name FROM tg_users WHERE chat_id = ?").bind(chat).first(); }
async function eloOf(env, chat) { return (await env.DB.prepare("SELECT elo FROM duel_elo WHERE chat_id = ?").bind(chat).first())?.elo ?? 1000; }
async function answerCb(env, q, text, alert = false) { await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert }); }

// member picker: in a group it lists that group's members (whoever taps is the challenger); in private, co-members of all the user's groups
async function duelPicker(env, chat, from, gid) {
  const rows = gid
    ? (await env.DB.prepare("SELECT u.chat_id, u.name, m.group_id AS gid FROM tg_members m JOIN tg_users u ON u.chat_id = m.user_id WHERE m.group_id = ? ORDER BY u.name LIMIT 40").bind(gid).all()).results
    : (await env.DB.prepare("SELECT u.chat_id, u.name, MIN(m.group_id) AS gid FROM tg_members me JOIN tg_members m ON m.group_id = me.group_id AND m.user_id <> me.user_id JOIN tg_users u ON u.chat_id = m.user_id JOIN tg_groups g ON g.chat_id = m.group_id AND g.active = 1 WHERE me.user_id = ? GROUP BY u.chat_id ORDER BY u.name LIMIT 40").bind(from).all()).results;
  if (!rows.length) { await tg(env, "sendMessage", { chat_id: chat, text: gid ? "Bellashuvda hali hech kim yo'q. Avval /qatnashish orqali qo'shiling." : "Siz hali biror guruh bellashuvida emassiz. Guruhingizda /duel yozing yoki u yerdagi «Duelga chaqirish» tugmasini bosing, bot sizni o'sha guruhga qo'shadi." }); return; }
  const kb = []; for (let i = 0; i < rows.length; i += 2) kb.push(rows.slice(i, i + 2).map(r => ({ text: nm(r).slice(0, 28), callback_data: `dp:${r.gid}:${r.chat_id}` })));
  await tg(env, "sendMessage", { chat_id: chat, text: "<b>⚔️ Duel</b>\n\nRaqibingizni tanlang. Ikkalangizga bir xil, faqat shu duel uchun yaratilgan jumboq beriladi. G'olib duel reytingida ochko oladi.", parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
}

async function onCallback(env, q) {
  const [k, x, y] = String(q.data || "").split(":"), from = q.from?.id;
  if (k === "dp") return duelPick(env, q, from, Number(x), Number(y));
  if (k === "da" || k === "dr") return duelAnswer(env, q, from, x, k === "da");
  if (k === "fb") return fbRate(env, q, from, x);
  await answerCb(env, q, "");
}

async function duelPick(env, q, from, gid, target) {
  if (q.message?.chat?.id === gid) await autoJoin(env, gid, q.from); // tapped in that group: they are in it
  if (!await canDM(env, from)) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, url: `https://t.me/${BOT_USER}?start=dg${gid}` }); // opens the bot; Start shows the picker in private
  const a = await duelUser(env, from), b = await duelUser(env, target);
  if (!a) return answerCb(env, q, "Avval bellashuvga qo'shiling: guruhdagi «Qatnashish» tugmasini bosing.", true);
  if (!b) return answerCb(env, q, "Bu o'yinchi topilmadi.", true);
  if (from === target) return answerCb(env, q, "O'zingiz bilan duel qilib bo'lmaydi 🙂", true);
  const inG = await env.DB.prepare("SELECT COUNT(*) AS c FROM tg_members WHERE group_id = ? AND user_id IN (?, ?)").bind(gid, from, target).first();
  if (inG.c < 2) return answerCb(env, q, "Ikkalangiz ham shu guruh bellashuvida bo'lishingiz kerak.", true);
  const day = tzDay();
  const dup2 = await env.DB.prepare("SELECT 1 FROM duels WHERE day = ?1 AND status IN ('pending','active','done') AND ((a = ?2 AND b = ?3) OR (a = ?3 AND b = ?2))").bind(day, from, target).first();
  if (dup2) return answerCb(env, q, `Bugun ${nm(b)} bilan duel allaqachon bor. Ertaga yana chaqiring!`, true);
  const open = await env.DB.prepare("SELECT COUNT(*) AS c FROM duels WHERE a = ? AND status = 'pending'").bind(from).first();
  if (open.c >= 3) return answerCb(env, q, "Javob kutilayotgan 3 ta chaqiruvingiz bor. Avval ular yakunlansin.", true);
  const id = rid(10);
  await env.DB.prepare("INSERT INTO duels (id, gid, a, b, seed, status, day, created) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)").bind(id, gid, from, target, rid(12), day, Date.now()).run();
  const [ea, eb] = [await eloOf(env, from), await eloOf(env, target)];
  const dm = await tg(env, "sendMessage", { chat_id: target, text: `<b>⚔️ ${esc(nm(a))} sizni duelga chaqirdi!</b>\n\nIkkalangiz bir xil, faqat shu duel uchun yaratilgan jumboqni o'ynaysiz. G'olib duel reytingida ochko oladi.\n\nDuel ochkolari: ${esc(nm(a))} ${ea} · siz ${eb}\n\n<b>24 soat ichida javob bering.</b>`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Qabul qilish", style: "success", callback_data: `da:${id}` }, { text: "Rad etish", callback_data: `dr:${id}` }]] } });
  if (!dm.ok) { await env.DB.prepare("UPDATE duels SET status = 'expired' WHERE id = ?").bind(id).run(); return answerCb(env, q, `Taklif ${nm(b)}ga yetib bormadi: u hali botga «Start» bosmagan. Unga @${BOT_USER} ni ochib Start bosishini ayting.`, true); }
  await answerCb(env, q, `Taklif ${nm(b)}ga yuborildi ✅`);
  await tg(env, "sendMessage", { chat_id: gid, text: `⚔️ ${esc(nm(a))} ${esc(nm(b))}ni duelga chaqirdi!`, parse_mode: "HTML" });
}

async function duelAnswer(env, q, from, id, yes) {
  const d = await env.DB.prepare("SELECT * FROM duels WHERE id = ?").bind(id || "").first();
  if (q.message) await tg(env, "editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
  if (!d || d.b !== from) return answerCb(env, q, "Bu chaqiruv topilmadi.", true);
  if (d.status !== "pending" || Date.now() - d.created > DUEL_TTL) return answerCb(env, q, "Bu chaqiruv endi amal qilmaydi.", true);
  const a = await duelUser(env, d.a), b = await duelUser(env, d.b);
  if (!yes) {
    await env.DB.prepare("UPDATE duels SET status = 'declined' WHERE id = ?").bind(id).run();
    await answerCb(env, q, "Rad etildi.");
    await tg(env, "sendMessage", { chat_id: d.a, text: `${nm(b)} bu safar duelni rad etdi. Boshqa raqibni tanlab ko'ring: /duel` });
    return;
  }
  await env.DB.prepare("UPDATE duels SET status = 'active', accepted = ? WHERE id = ?").bind(Date.now(), id).run();
  await answerCb(env, q, "Qabul qilindi ⚔️");
  const rules = "5 ta test, ikkalangizda bir xil jumboq. Boshlagandan keyin chiqib ketsangiz, natija 0 hisoblanadi. 24 soat ichida o'ynang.";
  await tg(env, "sendMessage", { chat_id: d.b, text: `<b>⚔️ Duel: siz va ${esc(nm(a))}</b>\n\n${rules}`, parse_mode: "HTML", reply_markup: duelBtn(id, b.client) });
  await tg(env, "sendMessage", { chat_id: d.a, text: `<b>⚔️ ${esc(nm(b))} chaqiruvingizni qabul qildi!</b>\n\n${rules}`, parse_mode: "HTML", reply_markup: duelBtn(id, a.client) });
  await tg(env, "sendMessage", { chat_id: d.gid, text: `⚔️ ${esc(nm(b))} ${esc(nm(a))}ning chaqiruvini qabul qildi. Natija ikkalasi o'ynab bo'lgach shu yerda chiqadi.`, parse_mode: "HTML" });
}

// who is calling from the site: Telegram initData if present, else the (aliased) client id
async function duelWho(env, b) {
  if (b.initData && env.TG_BOT_TOKEN) { const u = await tgUser(env, String(b.initData)); if (u) return u.id; }
  if (!CLIENT.test(b.client || "")) return null;
  const c = await mainClient(env, b.client);
  return (await env.DB.prepare("SELECT chat_id FROM tg_users WHERE client = ?").bind(c).first())?.chat_id ?? null;
}
async function duelState(env, d, me) {
  const side = d.a === me ? "a" : "b", other = side === "a" ? "b" : "a";
  const opp = await duelUser(env, d[other]);
  const out = { id: d.id, status: d.status, side, opp: nm(opp), me: { started: !!d[side + "_start"], done: d[side + "_score"] != null, score: d[side + "_score"] } };
  if (out.me.done) out.me.scores = JSON.parse(d[side + "_scores"] || "[]");
  if (d.status === "done") { out.oppScore = d[other + "_score"] ?? 0; out.oppScores = JSON.parse(d[other + "_scores"] || "[]"); out.delta = side === "a" ? d.delta : -d.delta; out.elo = await eloOf(env, me);
    if (d.card === 0) { const A = await duelUser(env, d.a), B = await duelUser(env, d.b); out.card = { a: nm(A), b: nm(B), sa: d.a_score ?? 0, sb: d.b_score ?? 0, as: JSON.parse(d.a_scores || "[]"), bs: JSON.parse(d.b_scores || "[]"), delta: d.delta, ea: await eloOf(env, d.a), eb: await eloOf(env, d.b) }; } }
  else out.oppDone = d[other + "_score"] != null;
  return out;
}
async function duelApi(env, path, b, ctx) {
  const me = await duelWho(env, b); if (!me) return { error: "Duel faqat Telegram orqali ochiladi. Botdagi «Duelni boshlash» tugmasini bosing." };
  let d = await env.DB.prepare("SELECT * FROM duels WHERE id = ?").bind(String(b.id || "")).first();
  if (!d || (d.a !== me && d.b !== me)) return { error: "Bu duel topilmadi." };
  d = await duelSweepOne(env, d);
  const side = d.a === me ? "a" : "b";
  if (path === "/duel/start") {
    if (d.status !== "active") return { error: "Bu duel endi faol emas.", state: await duelState(env, d, me) };
    if (d[side + "_start"]) return { error: "Bu duelni allaqachon boshlagansiz.", state: await duelState(env, d, me) };
    await env.DB.prepare(`UPDATE duels SET ${side}_start = ? WHERE id = ? AND ${side}_start IS NULL`).bind(Date.now(), d.id).run();
    return { seed: d.seed };
  }
  if (path === "/duel/card") { // PNG of the result, drawn in the app; accepted once, only while the group post is still waiting
    if (d.status !== "done" || d.card !== 0) return { ok: false };
    let bytes; try { bytes = Uint8Array.from(atob(String(b.png || "")), ch => ch.charCodeAt(0)); } catch { return { error: "bad image" }; }
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 1000 || bytes.length > 900000 || sig.some((v, i) => bytes[i] !== v)) return { error: "bad image" };
    return { ok: await duelPostGroup(env, d, bytes) };
  }
  if (path === "/duel/submit") {
    const scores = Array.isArray(b.scores) ? b.scores.map(Number) : [];
    if (scores.length !== 5 || scores.some(s => !Number.isInteger(s) || s < 0 || s > 100)) return { error: "bad scores" };
    if (d.status === "active" && d[side + "_start"] && d[side + "_score"] == null) {
      const total = Math.round(scores.reduce((x, s) => x + s, 0) / 5);
      await env.DB.prepare(`UPDATE duels SET ${side}_score = ?, ${side}_scores = ? WHERE id = ? AND ${side}_score IS NULL`).bind(total, JSON.stringify(scores), d.id).run();
      d = await env.DB.prepare("SELECT * FROM duels WHERE id = ?").bind(d.id).first();
      if (d.a_score != null && d.b_score != null) d = await duelSettle(env, d, ctx);
    }
  }
  return { state: await duelState(env, d, me) };
}
// group post for a settled duel; `card` = PNG bytes drawn by the finishing player's app (sent as a photo), else plain text
async function duelGroupText(env, d) {
  const A = await duelUser(env, d.a), B = await duelUser(env, d.b), sa = d.a_score ?? 0, sb = d.b_score ?? 0;
  return `<b>⚔️ Duel natijasi</b>\n\n${esc(nm(A))} ${sa} : ${sb} ${esc(nm(B))}` + (sa === sb ? "\n\n<b>Durang! 🤝</b>" : `\n\n<b>🏆 G'olib: ${esc(nm(sa > sb ? A : B))} (+${Math.abs(d.delta)} ochko)</b>`);
}
async function duelPostGroup(env, d, card) {
  const claim = await env.DB.prepare("UPDATE duels SET card = 1 WHERE id = ? AND card = 0").bind(d.id).run(); // exactly one group post per duel
  if (!claim.meta?.changes) return false;
  const text = await duelGroupText(env, d);
  if (card) {
    const f = new FormData(); f.append("chat_id", String(d.gid)); f.append("caption", text); f.append("parse_mode", "HTML"); f.append("photo", new Blob([card], { type: "image/png" }), "duel.png");
    const r = await fetch(`${env.TG_API || "https://api.telegram.org"}/bot${env.TG_BOT_TOKEN}/sendPhoto`, { method: "POST", body: f }).then(x => x.json()).catch(() => ({ ok: false }));
    if (r.ok) return true;
  }
  await tg(env, "sendMessage", { chat_id: d.gid, text, parse_mode: "HTML" });
  return true;
}
const CARD_WAIT = 25000; // how long the group post waits for the finishing player's picture before falling back to text
async function duelSettle(env, d, ctx) { // both played (or time ran out): Elo, then tell both and the group
  const sa = d.a_score ?? 0, sb = d.b_score ?? 0;
  const ra = await eloOf(env, d.a), rb = await eloOf(env, d.b), ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  const res = sa > sb ? 1 : sa < sb ? 0 : 0.5, delta = Math.round(ELO_K * (res - ea));
  const upd = await env.DB.prepare("UPDATE duels SET status = 'done', delta = ?, a_score = ?, b_score = ?, card = 0 WHERE id = ? AND status = 'active'").bind(delta, sa, sb, d.id).run();
  if (!upd.meta?.changes) return env.DB.prepare("SELECT * FROM duels WHERE id = ?").bind(d.id).first();
  const up = (chat, dd, w) => env.DB.prepare("INSERT INTO duel_elo (chat_id, elo, w, l, d) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET elo = elo + ?, w = w + excluded.w, l = l + excluded.l, d = d + excluded.d").bind(chat, 1000 + dd, w === 1 ? 1 : 0, w === 0 ? 1 : 0, w === .5 ? 1 : 0, dd).run();
  await up(d.a, delta, res); await up(d.b, -delta, 1 - res);
  const A = await duelUser(env, d.a), B = await duelUser(env, d.b);
  const head = `<b>⚔️ Duel natijasi</b>\n\n${esc(nm(A))} ${sa} : ${sb} ${esc(nm(B))}`;
  const tail = res === .5 ? "\n\n<b>Durang! 🤝</b>" : `\n\n<b>🏆 G'olib: ${esc(nm(res === 1 ? A : B))} (+${Math.abs(delta)} ochko)</b>`;
  const msg = { text: head + tail, parse_mode: "HTML" };
  const done = { ...d, status: "done", delta, a_score: sa, b_score: sb };
  if (ctx) ctx.waitUntil(new Promise(ok => setTimeout(ok, CARD_WAIT)).then(() => duelPostGroup(env, done)).catch(() => {})); // the app sends a picture meanwhile
  else await duelPostGroup(env, done);
  for (const c of [d.a, d.b]) await tg(env, "sendMessage", { chat_id: c, ...msg, text: msg.text + "\n\nYana duel: /duel" });
  return env.DB.prepare("SELECT * FROM duels WHERE id = ?").bind(d.id).first();
}
async function duelSweepOne(env, d) { // time's up: unanswered -> expired; accepted but unfinished -> missing side scores 0
  const now = Date.now();
  if (d.status === "pending" && now - d.created > DUEL_TTL) {
    await env.DB.prepare("UPDATE duels SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(d.id).run();
    const b = await duelUser(env, d.b); await tg(env, "sendMessage", { chat_id: d.a, text: `${nm(b)} 24 soat ichida javob bermadi, chaqiruv bekor bo'ldi. Boshqa raqib: /duel` });
    return { ...d, status: "expired" };
  }
  if (d.status === "active" && now - d.accepted > DUEL_TTL) {
    if (d.a_score == null && d.b_score == null && !d.a_start && !d.b_start) { await env.DB.prepare("UPDATE duels SET status = 'expired' WHERE id = ? AND status = 'active'").bind(d.id).run(); return { ...d, status: "expired" }; }
    return duelSettle(env, d);
  }
  return d;
}
async function duelSweep(env) { const r = await env.DB.prepare("SELECT * FROM duels WHERE (status = 'pending' AND created < ?1) OR (status = 'active' AND accepted < ?1) LIMIT 50").bind(Date.now() - DUEL_TTL).all(); for (const d of r.results) await duelSweepOne(env, d).catch(() => {}); }

// hourly: one-time nudges so duels don't just run out. bits in duels.nudged: 1 = unanswered invite (6h), 2 = unplayed after 3h, 4 = unplayed with 3h left
const H = 36e5;
async function duelRemind(env) {
  const hr = (new Date().getUTCHours() + 5) % 24; if (hr >= 23 || hr < 8) return; // no DMs at night (Tashkent)
  const now = Date.now(), left = t => Math.max(1, Math.ceil((DUEL_TTL - (now - t)) / H));
  const pend = await env.DB.prepare("SELECT * FROM duels WHERE status = 'pending' AND nudged & 1 = 0 AND created < ?1 AND created > ?2 LIMIT 50").bind(now - 6 * H, now - DUEL_TTL).all();
  for (const d of pend.results) {
    await env.DB.prepare("UPDATE duels SET nudged = nudged | 1 WHERE id = ?").bind(d.id).run();
    const a = await duelUser(env, d.a);
    await tg(env, "sendMessage", { chat_id: d.b, text: `<b>⚔️ ${esc(nm(a))} sizni duelda kutyapti!</b>\n\nChaqiruvga javob berishga <b>${left(d.created)} soat</b> qoldi.`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Qabul qilish", style: "success", callback_data: `da:${d.id}` }, { text: "Rad etish", callback_data: `dr:${d.id}` }]] } });
  }
  const act = await env.DB.prepare("SELECT * FROM duels WHERE status = 'active' AND nudged & 6 <> 6 AND accepted < ?1 AND accepted > ?2 LIMIT 50").bind(now - 3 * H, now - DUEL_TTL).all();
  for (const d of act.results) {
    const late = now - d.accepted > DUEL_TTL - 3 * H, bit = late ? 6 : 2;
    if ((d.nudged & bit) === bit) continue;
    await env.DB.prepare("UPDATE duels SET nudged = nudged | ? WHERE id = ?").bind(bit, d.id).run();
    for (const [me, other, start, score] of [[d.a, d.b, d.a_start, d.a_score], [d.b, d.a, d.b_start, d.b_score]]) {
      if (start || score != null) continue; // played, or started (one attempt only)
      const u = await duelUser(env, me), o = await duelUser(env, other); if (!u) continue;
      await tg(env, "sendMessage", { chat_id: me, text: `<b>⚔️ ${esc(nm(o))} bilan duelingiz kutyapti!</b>\n\nO'ynash uchun <b>${left(d.accepted)} soat</b> qoldi. Vaqt tugasa, natijangiz 0 hisoblanadi.`, parse_mode: "HTML", reply_markup: duelBtn(d.id, u.client) });
    }
  }
}

const duelCta = gid => ({ inline_keyboard: [[{ text: "⚔️ Duelga chaqirish", style: "primary", url: `https://t.me/${BOT_USER}?start=dg${gid}` }]] });
// 19:00 Tashkent: short duel reminder in every group, with the group's duel leader and today's duel count
async function duelNudge(env) {
  const groups = await env.DB.prepare("SELECT chat_id FROM tg_groups WHERE active = 1").all(), day = tzDay();
  for (const g of groups.results) {
    const lead = await env.DB.prepare("SELECT u.name, e.elo FROM tg_members m JOIN tg_users u ON u.chat_id = m.user_id JOIN duel_elo e ON e.chat_id = u.chat_id WHERE m.group_id = ? ORDER BY e.elo DESC LIMIT 1").bind(g.chat_id).first();
    const n = (await env.DB.prepare("SELECT COUNT(*) AS c FROM duels WHERE gid = ? AND day = ? AND status IN ('active','done')").bind(g.chat_id, day).first()).c;
    const info = [n ? `Bugun guruhda ${n} ta duel bo'ldi.` : "", lead ? `Duel peshqadami: 🥇 <b>${esc(nm(lead))}</b> · ${lead.elo} ochko` : ""].filter(Boolean).join("\n");
    const text = `<b>⚔️ Duel vaqti!</b>\n\nKunlik jumboqdan keyin kuch sinashmoqchimisiz? Guruhdoshingizni chaqiring, ikkalangizga <b>bir xil, yangi jumboq</b> beriladi.${info ? `\n\n${info}` : ""}\n\n<b>Boshlash: /duel</b> · Reyting: /duelreyting`;
    const r = await tg(env, "sendMessage", { chat_id: g.chat_id, text, parse_mode: "HTML", reply_markup: duelCta(g.chat_id) });
    if (!r.ok && (r.error_code === 403 || r.error_code === 400)) await env.DB.prepare("UPDATE tg_groups SET active = 0 WHERE chat_id = ?").bind(g.chat_id).run();
    await new Promise(res => setTimeout(res, 40));
  }
}
async function duelBoard(env, gid) {
  const r = await env.DB.prepare("SELECT u.name, e.elo, e.w, e.l, e.d FROM tg_members m JOIN tg_users u ON u.chat_id = m.user_id JOIN duel_elo e ON e.chat_id = u.chat_id WHERE m.group_id = ? ORDER BY e.elo DESC LIMIT 30").bind(gid).all();
  const text = r.results.length
    ? `<b>⚔️ Duel reytingi</b>\n\n${r.results.map((x, i) => `${MEDALS[i] || `${i + 1}.`} ${esc(nm(x))} · ${x.elo} (${x.w} g'alaba, ${x.l} mag'lubiyat${x.d ? `, ${x.d} durang` : ""})`).join("\n")}\n\n<b>Duelga chaqirish: /duel</b>`
    : "<b>⚔️ Duel reytingi hali bo'sh.</b>\n\nBirinchi bo'lib chaqiring: /duel";
  await tg(env, "sendMessage", { chat_id: gid, text, parse_mode: "HTML" });
}


// Telegram Mini App initData check (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function hmac(key, msg) { const k = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg))); }
async function tgUser(env, initData) {
  const q = new URLSearchParams(initData || ""), hash = q.get("hash"); if (!hash) return null; q.delete("hash");
  const dcs = [...q.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join("\n");
  const sig = [...await hmac(await hmac("WebAppData", env.TG_BOT_TOKEN), dcs)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (sig !== hash) return null;
  if (Date.now() / 1000 - Number(q.get("auth_date") || 0) > 90 * 86400) return null; // stale session
  try { const u = JSON.parse(q.get("user") || "null"); if (u && Number.isInteger(u.id)) { u.start = q.get("start_param") || ""; return u; } return null; } catch { return null; }
}
// One person, several device ids (a browser tab, a second webview): remember `from` as an alias of `to`
// and move its plays over (only days `to` has not played). Never touches another Telegram user's main id.
async function adoptClient(env, from, to) {
  if (!from || !to || from === to || !CLIENT.test(from) || !CLIENT.test(to)) return 0;
  if (await env.DB.prepare("SELECT 1 FROM tg_users WHERE client = ?").bind(from).first()) return 0;
  await env.DB.prepare("INSERT INTO aliases (alias, client, at) VALUES (?, ?, ?) ON CONFLICT(alias) DO UPDATE SET client = excluded.client, at = excluded.at").bind(from, to, Date.now()).run();
  const r = await env.DB.prepare("UPDATE plays SET client = ? WHERE client = ? AND date NOT IN (SELECT date FROM plays WHERE client = ?)").bind(to, from, to).run();
  return r.meta?.changes || 0;
}
async function mainClient(env, client) { const a = await env.DB.prepare("SELECT client FROM aliases WHERE alias = ?").bind(client).first(); return a ? a.client : client; }
// 21:00 check for the owner: a play that landed on an unknown id within 15 min of someone joining, while that person shows no play today
async function watchMisses(env) {
  const day = tzDay(), win = 15 * 60e3;
  const r = await env.DB.prepare(`SELECT DISTINCT u.name, p.total, p.created FROM plays p
    JOIN tg_users u ON (ABS(p.created - u.created) < ?1 OR EXISTS (SELECT 1 FROM tg_members m WHERE m.user_id = u.chat_id AND ABS(p.created - m.joined) < ?1))
    WHERE p.date = ?2 AND p.client NOT IN (SELECT client FROM tg_users WHERE client IS NOT NULL) AND p.client NOT IN (SELECT alias FROM aliases)
      AND NOT EXISTS (SELECT 1 FROM plays q WHERE q.date = ?2 AND q.client = u.client)`).bind(win, day).all();
  if (!r.results.length) return;
  const t = ms => new Date(ms + 5 * 3600e3).toISOString().slice(11, 16);
  await tg(env, "sendMessage", { chat_id: OWNER_ID, text: `Nazorat: bugun quyidagilarning natijasi Telegram akkauntiga ulanmagan bo'lishi mumkin (qo'shilgan vaqtiga yaqin nomsiz o'yin bor).\n\n` + r.results.map(x => `• ${x.name}: ${x.total} ball, ${t(x.created)}`).join("\n") + "\n\nTekshirib, ularni ulash kerak bo'lishi mumkin." });
}

// Group membership must never depend on the "Qatnashish" button alone: anyone who acts in a group
// (a command, a button there, or opening the game from that group's button) joins that group's board.
const gidParam = s => /^g-?\d{1,20}$/.test(s || "") ? Number(s.slice(1)) : null;
async function autoJoin(env, gid, from, announce = true) {
  if (!gid || !from || !Number.isInteger(from.id) || from.is_bot) return false;
  if (!await env.DB.prepare("SELECT 1 FROM tg_groups WHERE chat_id = ? AND active = 1").bind(gid).first()) return false;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 40) || "O'yinchi";
  await env.DB.prepare("INSERT OR IGNORE INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 0, ?)").bind(from.id, newClient(), name, Date.now()).run();
  const r = await env.DB.prepare("INSERT OR IGNORE INTO tg_members (group_id, user_id, joined) VALUES (?, ?, ?)").bind(gid, from.id, Date.now()).run();
  if (!r.meta?.changes) return false;
  if (announce) await tg(env, "sendMessage", { chat_id: gid, text: `${(await duelUser(env, from.id))?.name || name} bellashuvga qo'shildi 👋` });
  return true;
}
const canDM = async (env, id) => (await tg(env, "sendChatAction", { chat_id: id, action: "typing" })).ok;

// The bot's menu button opens the site without ?cid=, so the Mini App asks which site client belongs to this Telegram user.
async function whoami(env, initData, client) {
  const u = await tgUser(env, initData); if (!u) return null;
  const row = await env.DB.prepare("SELECT client FROM tg_users WHERE chat_id = ?").bind(u.id).first();
  if (row) { if (row.client !== client) await adoptClient(env, client, row.client); await autoJoin(env, gidParam(u.start), u); return row.client; }
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").slice(0, 60) || "Do'st";
  await env.DB.prepare("INSERT OR IGNORE INTO tg_users (chat_id, client, name, active, created) VALUES (?, ?, ?, 0, ?)").bind(u.id, client, name, Date.now()).run();
  await autoJoin(env, gidParam(u.start), u);
  return client;
}
export default {
  async fetch(req, env, ctx) {
    const h = cors(req, env), url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    try {
      if (url.pathname === "/tg/hook" && req.method === "POST") {
        if (!env.TG_BOT_TOKEN || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        const upd = await req.json().catch(() => null);
        if (upd?.message) await onMessage(env, upd.message);
        else if (upd?.my_chat_member) await onMyChatMember(env, upd.my_chat_member);
        else if (upd?.callback_query) await onCallback(env, upd.callback_query);
        else if (upd?.pre_checkout_query) { const q = upd.pre_checkout_query; await tg(env, "answerPreCheckoutQuery", { pre_checkout_query_id: q.id, ok: q.currency === "XTR" && /^don:[01]$/.test(q.invoice_payload), error_message: "To'lovni qabul qilib bo'lmadi, qayta urinib ko'ring." }); }
        return new Response("ok");
      }
      if (url.pathname === "/promo/go" && req.method === "GET") { await sendPromo(env); return new Response("ok"); } // one-off; sends at most once ever (meta flag)
      if (url.pathname === "/tg/setup" && req.method === "GET") {
        if (!env.TG_BOT_TOKEN || !env.TG_WEBHOOK_SECRET || url.searchParams.get("key") !== env.TG_WEBHOOK_SECRET) return json({ error: "forbidden" }, 403, h);
        return json(await tgSetup(env, url.origin), 200, h);
      }
      if (url.pathname === "/tg/whoami" && req.method === "POST") {
        const b = await req.json().catch(() => null);
        if (!env.TG_BOT_TOKEN || !b || typeof b.initData !== "string" || !CLIENT.test(b.client)) return json({ error: "bad body" }, 400, h);
        const client = await whoami(env, b.initData, b.client);
        return client ? json({ client }, 200, h) : json({ error: "forbidden" }, 403, h);
      }
      if (url.pathname === "/support/invoice" && req.method === "POST") {
        const b = await req.json().catch(() => null), n = Number(b?.stars);
        if (!env.TG_BOT_TOKEN || !Number.isInteger(n) || n < 1 || n > 10000) return json({ error: "bad body" }, 400, h);
        const link = await invoiceLink(env, n, !!b.anon);
        return link ? json({ link }, 200, h) : json({ error: "telegram" }, 502, h);
      }
      if (url.pathname === "/support" && req.method === "GET") return json(await supporters(env), 200, { ...h, "Cache-Control": "public, max-age=30" });
      if (url.pathname === "/stats" && req.method === "GET") {
        const date = url.searchParams.get("date") || todayAround()[1];
        if (!DATE.test(date)) return json({ error: "bad date" }, 400, h);
        const t = url.searchParams.get("total"); const total = t === null ? undefined : parseInt(t, 10);
        return json(await stats(env, date, total), 200, { ...h, "Cache-Control": "public, max-age=30" });
      }
      if (url.pathname === "/mygroups" && req.method === "GET") {
        const client = url.searchParams.get("client") || "", date = url.searchParams.get("date") || tzDay();
        if (!CLIENT.test(client) || !DATE.test(date)) return json({ error: "bad query" }, 400, h);
        return json({ groups: await myGroups(env, client, date) }, 200, h);
      }
      if (url.pathname === "/live" && req.method === "GET") return json(await live(env), 200, { ...h, "Cache-Control": "public, max-age=20" });
      if (url.pathname === "/summary" && req.method === "GET") return json(await summary(env, Math.min(Math.max(parseInt(url.searchParams.get("days") || "14", 10) || 14, 7), 60)), 200, { ...h, "Cache-Control": "public, max-age=60" });
      if (url.pathname === "/ping" && req.method === "POST") {
        const b = await req.json().catch(() => null);
        if (!b || !CLIENT.test(b.client)) return json({ error: "bad body" }, 400, h);
        const day = tzDay(), now = Date.now();
        const ins = await env.DB.prepare("INSERT OR IGNORE INTO visits (date, client, last) VALUES (?, ?, ?)").bind(day, b.client, now).run();
        if (ins.meta?.changes) { // first visit today: bump daily (and maybe all-time) visitor counters
          await bump(env, "v:" + day);
          if (!await env.DB.prepare("SELECT 1 FROM visits WHERE client = ? AND date <> ? LIMIT 1").bind(b.client, day).first()) await bump(env, "visitors");
        } else await env.DB.prepare("UPDATE visits SET last = ? WHERE date = ? AND client = ?").bind(now, day, b.client).run();
        return json(await live(env), 200, h);
      }
      if (url.pathname === "/submit" && req.method === "POST") {
        const b = await req.json().catch(() => null);
        if (!b || !DATE.test(b.date) || !CLIENT.test(b.client) || !Array.isArray(b.scores) || b.scores.length !== 5) return json({ error: "bad body" }, 400, h);
        if (!todayAround().includes(b.date)) return json({ error: "only today's puzzle counts" }, 400, h);
        const scores = b.scores.map(Number); if (scores.some(s => !Number.isInteger(s) || s < 0 || s > 100)) return json({ error: "bad scores" }, 400, h);
        const total = Math.round(scores.reduce((a, s) => a + s, 0) / 5);
        // inside Telegram the play always goes to the Telegram user's own client, even if the page started with another one
        // (whoami timed out on a slow network, or a second webview) - otherwise the group board never sees it
        let client = b.client;
        if (b.initData && env.TG_BOT_TOKEN) { const c = await whoami(env, String(b.initData), b.client).catch(() => null); if (c && CLIENT.test(c)) client = c; }
        if (client === b.client) client = await mainClient(env, client); // a browser id already linked to a Telegram user
        const ins = await env.DB.prepare("INSERT OR IGNORE INTO plays (date, client, total, scores, created) VALUES (?, ?, ?, ?, ?)").bind(b.date, client, total, JSON.stringify(scores), Date.now()).run();
        const fresh = !!ins.meta?.changes;
        if (fresh) {
          await bump(env, "p:" + b.date); await bump(env, "s:" + b.date, total);
          if (!await env.DB.prepare("SELECT 1 FROM plays WHERE client = ? AND date <> ? LIMIT 1").bind(client, b.date).first()) await bump(env, "players");
          ctx.waitUntil(announcePlay(env, client, b.date, total).catch(() => {})); ctx.waitUntil(maybeAskSupport(env, client).catch(() => {})); ctx.waitUntil(maybeAskFeedback(env, client).catch(() => {}));
        }
        const out = await stats(env, b.date, total, fresh ? [total, scores] : null);
        return json(client !== b.client ? { ...out, client } : out, 200, h);
      }
      if (url.pathname === "/admin/stats" && req.method === "POST") {
        const b = await req.json().catch(() => null); const out = b && await adminStats(env, String(b.initData || ""));
        return out ? json(out, 200, { ...h, "Cache-Control": "no-store" }) : json({ error: "forbidden" }, 403, h);
      }
      if (["/duel/info", "/duel/start", "/duel/submit", "/duel/card"].includes(url.pathname) && req.method === "POST") {
        const b = await req.json().catch(() => null); if (!b) return json({ error: "bad body" }, 400, h);
        return json(await duelApi(env, url.pathname, b, ctx), 200, h);
      }
      if (url.pathname === "/myplay" && req.method === "GET") { // lets a second device (or a fresh Telegram webview) show today's result instead of a new game
        const client = url.searchParams.get("client") || "", date = url.searchParams.get("date") || "";
        if (!CLIENT.test(client) || !DATE.test(date)) return json({ error: "bad query" }, 400, h);
        const r = await env.DB.prepare("SELECT total, scores FROM plays WHERE date = ? AND client = ?").bind(date, client).first();
        return json(r ? { total: r.total, scores: JSON.parse(r.scores) } : {}, 200, h);
      }
      return json({ error: "not found" }, 404, h);
    } catch (e) { return json({ error: "server error" }, 500, h); }
  },
  async scheduled(event, env, ctx) { // hourly: duels; 04:00 UTC = 09:00 Tashkent (morning), 14:00 UTC = 19:00 (evening), 16:00 UTC = 21:00 (group boards)
    if (!env.TG_BOT_TOKEN) return;
    if (event.cron === "0 * * * *") ctx.waitUntil(duelSweep(env).catch(() => {}).then(() => duelRemind(env)).catch(() => {}).then(() => fbRemind(env)).catch(() => {}).then(() => sendPromo(env)).catch(() => {})); // hourly: duel expiry + reminders
    else if (event.cron === "0 16 * * *") ctx.waitUntil(Promise.all([postBoards(env), watchMisses(env).catch(() => {})]));
    else if (event.cron === "0 4 * * *") ctx.waitUntil(Promise.all([remind(env, false), morningGroups(env)]));
    else if (event.cron === "0 14 * * *") ctx.waitUntil(Promise.all([remind(env, true), duelNudge(env).catch(() => {})]));
  },
};
