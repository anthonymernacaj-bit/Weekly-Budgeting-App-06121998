// Shared helpers for the Weekly Budget Netlify functions.
import { getStore } from "@netlify/blobs";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { timingSafeEqual } from "node:crypto";

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
export function mkeyOf(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + (6 - dt.getUTCDay())); // Saturday of that Sunday–Saturday week
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}`;
}
const daysBetween = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);
export const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const round2 = n => Math.round(n * 100) / 100;
function cfgFor(settings, k) {
  let v = null;
  for (const x of (settings?.versions || [])) if (x.from <= k) v = x;
  return v || { categories: [], bills: [] };
}

/* Plaid personal-finance categories that are never "spending" here:
   money moving between your own accounts, card and loan payments, income, and rent (already a bill). */
const IGNORE_PRIMARY = new Set(["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS", "INCOME"]);
const IGNORE_DETAILED = new Set(["RENT_AND_UTILITIES_RENT"]);

function autoIgnore(t, name, cfg) {
  const pfc = t.personal_finance_category || {};
  if (IGNORE_PRIMARY.has(pfc.primary) || IGNORE_DETAILED.has(pfc.detailed)) return true;
  const n = norm(name);
  return (cfg.bills || []).some(b => { const bn = norm(b.name); return bn.length >= 4 && (n.includes(bn) || bn.includes(n) && n.length >= 4); });
}
function pickCategory(t, name, cfg, merchants) {
  const names = (cfg.categories || []).map(c => c.name);
  const has = n => names.includes(n);
  const learned = merchants?.[norm(name)];
  if (learned && has(learned.c)) return learned.c;
  const pfc = t.personal_finance_category || {};
  const guess =
    pfc.detailed === "FOOD_AND_DRINK_GROCERIES" ? "Groceries" :
    pfc.detailed === "TRANSPORTATION_GAS" ? "Gas" :
    pfc.primary === "FOOD_AND_DRINK" ? "Dining Out" :
    ["GENERAL_MERCHANDISE", "ENTERTAINMENT", "TRAVEL", "PERSONAL_CARE"].includes(pfc.primary) ? "Discretionary" : "Misc";
  if (has(guess)) return guess;
  return has("Misc") ? "Misc" : (names[0] || "Misc");
}

/* ---- sync every linked item into the month documents ---- */
export async function syncAll() {
  const ps = plaidStore(), ds = dataStore();
  const items = (await ps.get("items", { type: "json" })) || [];
  if (!items.length) return { added: 0, modified: 0, removed: 0, items: [] };
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
  for (const item of items) {
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
      const tx = {
        id: prev?.id || "p_" + t.transaction_id, pid: t.transaction_id, source: "plaid",
        date, name, amount: round2(t.amount), cat: pickCategory(t, name, cfg, settings.merchants),
        account: acct[t.account_id] || item.institution || "Linked account", pending: !!t.pending,
        ignored: autoIgnore(t, name, cfg),
      };
      if (prev?.edited) { tx.name = prev.name; tx.cat = prev.cat; tx.ignored = !!prev.ignored; tx.edited = true; }
      return tx;
    };

    for (const t of added) {
      const date = t.authorized_date || t.date;
      if (date < SYNC_START || tomb.has(t.transaction_id)) continue;
      if (t.pending_transaction_id && tomb.has(t.pending_transaction_id)) { tomb.add(t.transaction_id); continue; }
      // A posted transaction replaces its pending version and keeps any edits made to it.
      let prev = take(t.transaction_id) || (t.pending_transaction_id && (take(t.pending_transaction_id) || removedKept[t.pending_transaction_id])) || null;
      if (!prev) {
        // Link to a matching manual entry instead of duplicating it (same amount, within 3 days).
        for (const k in months) {
          const i = months[k].tx.findIndex(x => !x.pid && Math.abs(x.amount - t.amount) < 0.005 && daysBetween(x.date, date) <= 3);
          if (i >= 0) { prev = { ...months[k].tx.splice(i, 1)[0], edited: true }; dirty.add(k); break; }
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
  return { ...counts, items: items.map(publicItem) };
}

export const publicItem = i => ({ item_id: i.item_id, institution: i.institution, accounts: i.accounts, lastSync: i.lastSync || null, error: i.error || null, added: i.added });
