// Shared helpers for the Weekly Budget Netlify functions.
import { getStore } from "@netlify/blobs";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { parseAlert, similarName, guessCategory, holdsThenSettles } from "./textalert.mjs";

export const SYNC_START = process.env.SYNC_START_DATE || "2026-09-01";

export const dataStore = () => getStore({ name: "budget", consistency: "strong" });
export const plaidStore = () => getStore({ name: "plaid", consistency: "strong" });

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/* Every request must carry the APP_PASSCODE set in Netlify's environment variables. */
export function authorized(req) {
  const want = process.env.APP_PASSCODE || "";
  const got = req.headers.get("x-app-passcode") || "";
  if (!want) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

let _plaid = null;
export function plaid() {
  if (_plaid) return _plaid;
  const env = process.env.PLAID_ENV || "sandbox";
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) throw new Error("Set PLAID_CLIENT_ID and PLAID_SECRET in Netlify.");
  _plaid = new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: { headers: { "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID, "PLAID-SECRET": process.env.PLAID_SECRET } },
  }));
  return _plaid;
}
export const plaidError = e => e?.response?.data || { error_message: e?.message || String(e) };

/* ---- date + budget helpers (same rules as the app) ---- */
const pad = n => String(n).padStart(2, "0");
// Purchases belong to the calendar month of their date (budgets reset on the 1st).
export function mkeyOf(isoDate) { return String(isoDate).slice(0, 7); }
const daysBetween = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);
export const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const round2 = n => Math.round(n * 100) / 100;
function cfgFor(settings, k) {
  let v = null;
  for (const x of (settings?.versions || [])) if (x.from <= k) v = x;
  if (!v) return { categories: [] };
  // Older settings kept bills in their own list; treat them as budget items in the "bill" group.
  const cats = (v.categories || []).slice();
  for (const b of (v.bills || [])) if (!cats.some(c => c.name === b.name)) cats.push({ name: b.name, group: "bill", limit: b.amount });
  return { categories: cats };
}

/* Never spending here: money between your own accounts, paying off a credit card (the card's
   purchases are already counted), and income. */
const IGNORE_PRIMARY = new Set(["TRANSFER_IN", "TRANSFER_OUT", "INCOME"]);
const IGNORE_DETAILED = new Set(["LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"]);
/* Payments that are almost always a bill. They wait in "Unassigned" until you assign them to one. */
const BILL_LIKE_PRIMARY = new Set(["RENT_AND_UTILITIES", "LOAN_PAYMENTS"]);
export const UNASSIGNED = "Unassigned";

function autoIgnore(t, learned) {
  if (learned) return !!learned.i;          // you've decided before how this payee counts
  const pfc = t.personal_finance_category || {};
  return IGNORE_PRIMARY.has(pfc.primary) || IGNORE_DETAILED.has(pfc.detailed);
}
function pickCategory(t, cfg, learned) {
  const names = (cfg.categories || []).map(c => c.name);
  const has = n => names.includes(n);
  if (learned && has(learned.c)) return learned.c;
  const pfc = t.personal_finance_category || {};
  if (BILL_LIKE_PRIMARY.has(pfc.primary) && !IGNORE_DETAILED.has(pfc.detailed)) return UNASSIGNED;
  const guess =
    pfc.detailed === "FOOD_AND_DRINK_GROCERIES" ? "Groceries" :
    pfc.detailed === "TRANSPORTATION_GAS" ? "Gas" :
    pfc.primary === "FOOD_AND_DRINK" ? "Dining Out" :
    ["GENERAL_MERCHANDISE", "ENTERTAINMENT", "TRAVEL", "PERSONAL_CARE"].includes(pfc.primary) ? "Discretionary" : "Misc";
  if (has(guess)) return guess;
  const fallback = (cfg.categories || []).find(c => c.name === "Misc") || (cfg.categories || []).find(c => c.group !== "bill");
  return fallback ? fallback.name : "Misc";
}

/* ---- what each kind of link is for ----
   Spending links (banks, credit cards) sync purchases into Spending and their balances show in Net Worth.
   Net Worth links (investments, home and car loans) only report balances; their activity never reaches Spending. */
export const LINK_KINDS = {
  bank:        { scope: "spending", products: ["transactions"] },
  credit:      { scope: "spending", products: ["transactions"] },
  investments: { scope: "networth", products: ["investments"], account_filters: { investment: { account_subtypes: ["all"] } } },
  homeLoan:    { scope: "networth", products: ["liabilities"],  account_filters: { loan: { account_subtypes: ["mortgage", "home equity"] } } },
  carLoan:     { scope: "networth", products: ["transactions"], account_filters: { loan: { account_subtypes: ["auto"] } } },
  student:     { scope: "networth", products: ["liabilities"],  account_filters: { loan: { account_subtypes: ["student"] } } },
  // Extra banks and cards added from Net Worth that should NOT feed Spending
  bankNW:      { scope: "networth", products: ["transactions"], account_filters: { depository: { account_subtypes: ["all"] } } },
  creditNW:    { scope: "networth", products: ["transactions"], account_filters: { credit: { account_subtypes: ["all"] } } },
};
export const scopeOf = item => item.scope === "networth" ? "networth" : "spending";   // links made before Net Worth existed are Spending links

export const mapAccounts = acc => acc.map(a => ({
  id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
  balance: a.balances?.current ?? null, available: a.balances?.available ?? null, limit: a.balances?.limit ?? null,
}));
/* Latest balances for every account on a link (no extra Plaid product needed). */
export async function refreshBalances(item) {
  const acc = (await plaid().accountsGet({ access_token: item.access_token })).data.accounts;
  item.accounts = mapAccounts(acc);
  item.balancesAt = new Date().toISOString();
}

/* ---- net worth, recorded once a day (same rules as the app's Net Worth tab) ---- */
function nwCategory(a) {
  const st = String(a.subtype || "").toLowerCase();
  if (a.type === "depository") return "bank";
  if (a.type === "investment" || a.type === "brokerage") return "invest";
  if (a.type === "credit") return "credit";
  if (a.type === "loan") return st === "mortgage" || st === "home equity" ? "homeLoan" : st === "auto" ? "carLoan" : st === "student" ? "student" : "other";
  return null;
}
export function netWorthOf(nw, items) {
  const L = { invest: 0, bank: 0, credit: 0, homeLoan: 0, carLoan: 0, student: 0, other: 0 };
  for (const it of items) for (const a of (it.accounts || [])) { const c = nwCategory(a); if (c) L[c] += +a.balance || 0; }
  // A typed-in amount wins over that category's linked balances (they're paused in Net Worth, still linked)
  const either = (k, cat = k) => nw[k] != null ? nw[k] : L[cat];
  const assets = (nw.home || 0) + (nw.car || 0) + either("invest") + either("bank");
  const liab = either("credit") + either("homeLoan") + either("carLoan") + either("student") + either("otherLoans", "other") + (nw.other || []).reduce((s, o) => s + (o.value || 0), 0);
  return { n: round2(assets - liab), a: round2(assets), l: round2(liab) };
}
// Days follow your time zone, not the server's (set TIME_ZONE in Netlify to change it).
export const localDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: process.env.TIME_ZONE || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export async function recordNetWorth(items) {
  try {
    const ds = dataStore();
    const nw = await ds.get("networth", { type: "json" });
    if (!nw || !nw.setup) return;
    items = items || (await plaidStore().get("items", { type: "json" })) || [];
    const hist = (await ds.get("nwhist", { type: "json" })) || { kind: "nwhist", days: {} };
    hist.days = hist.days || {};
    hist.days[localDay()] = netWorthOf(nw, items);
    await ds.setJSON("nwhist", hist);
  } catch (e) { /* the chart just misses this update */ }
}

/* ---- sync every linked item into the month documents ---- */
export async function syncAll() {
  const ps = plaidStore(), ds = dataStore();
  const items = (await ps.get("items", { type: "json" })) || [];
  if (!items.length) { await recordNetWorth([]); return { added: 0, modified: 0, removed: 0, items: [] }; }

  // Balances first, for every link. Net Worth links stop here: their transactions are never pulled.
  for (const item of items) {
    try { await refreshBalances(item); if (scopeOf(item) === "networth") { item.error = null; item.lastSync = item.balancesAt; } }
    catch (e) { item.error = plaidError(e).error_code || "SYNC_FAILED"; }
  }
  const spendingItems = items.filter(i => scopeOf(i) === "spending");
  const settings = (await ds.get("settings", { type: "json" })) || {};
  const tomb = new Set(((await ds.get("tombstones", { type: "json" })) || {}).ids || []);

  // Load every month doc from the start month on, so we can find transactions by Plaid id.
  const startKey = mkeyOf(SYNC_START);
  const months = {};
  const { blobs } = await ds.list({ prefix: "m-" });
  for (const b of blobs) { const k = b.key.slice(2); if (k >= startKey) months[k] = await ds.get(b.key, { type: "json" }); }
  const dirty = new Set();
  const getMonth = k => (months[k] ||= { kind: "month", month: k, tx: [] });
  const findPid = pid => { for (const k in months) { const i = months[k].tx.findIndex(t => t.pid === pid); if (i >= 0) return [k, i]; } return null; };
  const take = pid => { const f = findPid(pid); if (!f) return null; const [k, i] = f; dirty.add(k); return months[k].tx.splice(i, 1)[0]; };
  const put = tx => { const k = mkeyOf(tx.date); getMonth(k).tx.push(tx); dirty.add(k); };

  const counts = { added: 0, modified: 0, removed: 0 };
  for (const item of spendingItems) {
    const acct = Object.fromEntries((item.accounts || []).map(a => [a.id, `${item.institution || "Bank"} ••${a.mask || ""}`.trim()]));
    let cursor = item.cursor || null, added = [], modified = [], removed = [];
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let c = cursor, more = true; added = []; modified = []; removed = [];
        try {
          while (more) {
            const r = (await plaid().transactionsSync({ access_token: item.access_token, cursor: c || undefined, count: 500, options: { include_personal_finance_category: true } })).data;
            added.push(...r.added); modified.push(...r.modified); removed.push(...r.removed);
            more = r.has_more; c = r.next_cursor;
          }
          cursor = c; break;
        } catch (e) {
          if (plaidError(e).error_code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") continue; // restart from last saved cursor
          throw e;
        }
      }
      item.error = null;
    } catch (e) {
      item.error = plaidError(e).error_code || "SYNC_FAILED";
      continue;
    }

    const removedKept = {};
    for (const r of removed) { const old = take(r.transaction_id); if (old) { removedKept[r.transaction_id] = old; counts.removed++; } }

    const build = (t, prev) => {
      const date = t.authorized_date || t.date;
      const name = t.merchant_name || t.name;
      const cfg = cfgFor(settings, mkeyOf(date));
      const learned = settings.merchants?.[norm(name)] || null;
      const tx = {
        id: prev?.id || "p_" + t.transaction_id, pid: t.transaction_id, source: "plaid",
        date, name, amount: round2(t.amount), cat: pickCategory(t, cfg, learned),
        account: acct[t.account_id] || item.institution || "Linked account", pending: !!t.pending,
        ignored: autoIgnore(t, learned),
      };
      if (prev?.edited) { tx.name = prev.name; tx.cat = prev.cat; tx.ignored = !!prev.ignored; tx.edited = true; }
      if (prev?.fromText) tx.fromText = true;
      if (prev?.holdAmt != null) tx.holdAmt = prev.holdAmt;   // what the text said, before the bank processed it
      return tx;
    };

    for (const t of added) {
      const date = t.authorized_date || t.date;
      if (date < SYNC_START || tomb.has(t.transaction_id)) continue;
      if (t.pending_transaction_id && tomb.has(t.pending_transaction_id)) { tomb.add(t.transaction_id); continue; }
      // A posted transaction replaces its pending version and keeps any edits made to it.
      let prev = take(t.transaction_id) || (t.pending_transaction_id && (take(t.pending_transaction_id) || removedKept[t.pending_transaction_id])) || null;
      if (!prev) {
        // Confirm a hold from a text alert (or link a manual entry) instead of duplicating it: same amount within 3 days,
        // or, for a text hold, the same place within 4 days with a bit more added (a tip), or any amount where the
        // first charge is only a hold (gas pumps, hotels, rentals, rides, $1 card checks).
        const pname = t.merchant_name || t.name; let best = null;
        for (const k in months) months[k].tx.forEach((x, i) => {
          if (x.pid) return;
          const days = daysBetween(x.date, date), text = x.source === "text";
          const same = text && (similarName(x.name, pname) || similarName(x.tname, pname) || similarName(x.name, t.name));
          const exact = Math.abs(x.amount - t.amount) < 0.005 && days <= 3;
          const tip = same && days <= 4 && t.amount > x.amount && t.amount <= x.amount * 1.35 + 0.01;
          const settles = same && days <= 4 && (x.amount <= 1.5 || holdsThenSettles(x.tname || x.name) || holdsThenSettles(pname));
          if (!exact && !tip && !settles) return;
          const score = (exact ? 8 : 0) + (same ? 4 : 0) + (tip ? 2 : 0) - days / 10 - Math.abs(x.amount - t.amount) / Math.max(1, t.amount);
          if (!best || score > best.score) best = { k, i, score };
        });
        if (best) {
          const x = months[best.k].tx.splice(best.i, 1)[0]; dirty.add(best.k);
          // A text-alert purchase you haven't touched takes the bank's name and category; one you edited keeps yours.
          prev = x.source === "text" ? { ...(x.edited ? x : { id: x.id }), fromText: true, holdAmt: x.amount } : { ...x, edited: true };
        }
      }
      put(build(t, prev)); counts.added++;
    }
    for (const t of modified) {
      const date = t.authorized_date || t.date;
      if (tomb.has(t.transaction_id)) continue;
      const prev = take(t.transaction_id);
      if (!prev && date < SYNC_START) continue;
      put(build(t, prev)); counts.modified++;
    }
    item.cursor = cursor;
    item.lastSync = new Date().toISOString();
  }

  for (const k of dirty) await ds.setJSON("m-" + k, months[k]);
  await ps.setJSON("items", items);
  await recordNetWorth(items);
  return { ...counts, items: items.map(publicItem) };
}

/* ---- a purchase from a bank's text alert (sent by the iPhone Shortcut) ----
   It shows up in Spending right away. When the bank's version comes in through Plaid, it replaces this one. */
export async function addTextPurchase(raw) {
  const p = parseAlert(raw);
  if (!p.ok) return p;
  const ds = dataStore();
  const settings = (await ds.get("settings", { type: "json" })) || {};
  // The day on the text when it has one (a text can arrive after midnight, or late), otherwise today
  const now = new Date(), todayIso = localDay(now), near = d => d && daysBetween(d, todayIso) <= 14 && d <= localDay(new Date(now.getTime() + 864e5));
  const date = near(p.date) ? p.date : todayIso, k = mkeyOf(date);
  const doc = (await ds.get("m-" + k, { type: "json" })) || { kind: "month", month: k, tx: [] };
  doc.tx ||= [];
  const th = createHash("sha256").update(String(raw).replace(/\s+/g, " ").trim().toLowerCase()).digest("hex").slice(0, 16);
  // The same text twice (the automation ran twice, or the bank resent it)
  if (doc.tx.some(t => t.th === th && now - Date.parse(t.at || 0) < 6 * 3600e3)) return { ok: false, skipped: "already added" };
  // The bank got there first: Plaid already brought in this purchase today
  const hit = doc.tx.find(t => t.pid && !t.fromText && Math.abs(t.amount - p.amount) < 0.005 && daysBetween(t.date, date) <= 1 && similarName(t.name, p.name));
  if (hit) { hit.fromText = true; hit.holdAmt = p.amount; await ds.setJSON("m-" + k, doc); return { ok: true, matched: true, name: hit.name, amount: hit.amount }; }

  const cfg = cfgFor(settings, k), names = (cfg.categories || []).map(c => c.name);
  const learned = settings.merchants?.[norm(p.name)] || null;
  const name = learned?.n || p.name;
  const fallback = (cfg.categories || []).find(c => c.name === "Misc") || (cfg.categories || []).find(c => c.group !== "bill");
  const cat = (learned && names.includes(learned.c) && learned.c) || guessCategory(p.name, names) || (fallback ? fallback.name : "Misc");
  const tx = { id: "t_" + randomUUID().replace(/-/g, "").slice(0, 14), source: "text", date, name, amount: p.amount, cat, account: p.account, at: now.toISOString(), th, tname: p.name };
  if (learned?.i) tx.ignored = true;
  doc.tx.push(tx);
  await ds.setJSON("m-" + k, doc);
  return { ok: true, added: { name: tx.name, amount: tx.amount, cat: tx.cat, date, account: tx.account } };
}

/* Saving a month from the app can't drop a text-alert purchase that arrived after the app last loaded. */
export async function keepNewTextPurchases(ds, id, body, seenAt) {
  const seen = Date.parse(seenAt || "");
  if (!seen || !/^m-/.test(id)) return { body, merged: 0 };
  const cur = await ds.get(id, { type: "json" });
  const have = new Set((body.tx || []).map(t => t.id));
  const missed = (cur?.tx || []).filter(t => t.source === "text" && t.at && Date.parse(t.at) > seen && !have.has(t.id));
  return missed.length ? { body: { ...body, tx: (body.tx || []).concat(missed) }, merged: missed.length } : { body, merged: 0 };
}

export const publicItem = i => ({ item_id: i.item_id, institution: i.institution, accounts: i.accounts, scope: scopeOf(i), kind: i.kind || null, lastSync: i.lastSync || null, balancesAt: i.balancesAt || null, error: i.error || null, added: i.added });
