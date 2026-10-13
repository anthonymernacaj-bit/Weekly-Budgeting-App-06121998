// All app requests: /api/data (your budget) and /api/plaid/* (linked accounts).
import { dataStore, plaidStore, json, authorized, plaid, plaidError, syncAll, publicItem, LINK_KINDS, mapAccounts, recordNetWorth, addTextPurchase, keepNewTextPurchases } from "../lib/budget.mjs";

const DOC_ID = /^(settings|tombstones|networth|nwhist|goals|m-\d{4}-\d{2})$/;

/* Plaid calls this address the moment it has new transactions (pending ones included). */
const webhookUrl = req => `${new URL(req.url).origin}/api/plaid/webhook`;
const SYNC_CODES = new Set(["SYNC_UPDATES_AVAILABLE", "INITIAL_UPDATE", "HISTORICAL_UPDATE", "DEFAULT_UPDATE", "TRANSACTIONS_REMOVED"]);

/* Make sure every linked bank points its notifications at this site (older links were made before notifications existed). */
async function ensureWebhooks(req, ps, items) {
  const want = webhookUrl(req); let changed = false;
  for (const it of items) {
    if (it.webhook === want) continue;
    try { await plaid().itemWebhookUpdate({ access_token: it.access_token, webhook: want }); it.webhook = want; changed = true; }
    catch (e) { /* try again next time */ }
  }
  if (changed) await ps.setJSON("items", items);
}

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "plaid" && parts[1] === "webhook" && req.method === "POST") {
    // Only ever triggers a sync of banks you've linked; nothing in the message is stored or trusted.
    try {
      const body = await req.json().catch(() => ({}));
      const ps = plaidStore();
      const items = (await ps.get("items", { type: "json" })) || [];
      if (body.webhook_type !== "TRANSACTIONS" || !SYNC_CODES.has(body.webhook_code) || !items.some(i => i.item_id === body.item_id)) return json({ ok: true });
      const last = Date.parse((await ps.get("lastWebhookSync", { type: "json" }))?.at || 0) || 0;
      if (Date.now() - last < 20000) return json({ ok: true, skipped: "recent" });
      await ps.setJSON("lastWebhookSync", { at: new Date().toISOString() });
      await syncAll();
    } catch (e) { /* Plaid only needs a 200 */ }
    return json({ ok: true });
  }
  if (!process.env.APP_PASSCODE) return json({ error: "Set APP_PASSCODE in Netlify's environment variables." }, 500);
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);

  try {
    /* ---------- budget data ---------- */
    if (parts[0] === "data") {
      const ds = dataStore();
      if (req.method === "GET" && !parts[1]) {
        const now = new Date().toISOString();
        const { blobs } = await ds.list();
        const docs = {};
        for (const b of blobs) if (DOC_ID.test(b.key)) docs[b.key] = await ds.get(b.key, { type: "json" });
        return json({ docs, now });
      }
      const id = parts[1];
      if (!DOC_ID.test(id || "")) return json({ error: "bad document id" }, 400);
      if (req.method === "PUT") {
        const kept = await keepNewTextPurchases(ds, id, await req.json(), req.headers.get("x-seen-at"));
        await ds.setJSON(id, kept.body);
        if (id === "networth") await recordNetWorth();   // today's point on the chart follows your edits right away
        return json({ ok: true, merged: kept.merged });
      }
      if (req.method === "DELETE") { await ds.delete(id); return json({ ok: true }); }
    }

    /* ---------- a bank's purchase text, sent by the iPhone Shortcut ---------- */
    if (parts[0] === "text" && req.method === "POST") {
      const type = req.headers.get("content-type") || "";
      const raw = type.includes("json") ? ((await req.json().catch(() => ({}))).text || "") : await req.text();
      return json(await addTextPurchase(String(raw).slice(0, 2000)));
    }

    /* ---------- Plaid ---------- */
    if (parts[0] === "plaid") {
      const ps = plaidStore();
      const items = (await ps.get("items", { type: "json" })) || [];

      if (parts[1] === "link-token" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const update = body.item_id ? items.find(i => i.item_id === body.item_id) : null;
        const kind = LINK_KINDS[body.kind] || LINK_KINDS.bank;
        const r = await plaid().linkTokenCreate({
          user: { client_user_id: "weekly-budget-owner" },
          client_name: "Weekly Budget",
          country_codes: ["US"], language: "en", webhook: webhookUrl(req),
          // Update mode: sign in again and add or remove which accounts are shared
          ...(update ? { access_token: update.access_token, update: { account_selection_enabled: true } } : {
            products: kind.products,
            ...(kind.scope === "spending" ? { transactions: { days_requested: 90 } } : {}),
            ...(kind.account_filters ? { account_filters: kind.account_filters } : {}),
          }),
        });
        return json({ link_token: r.data.link_token });
      }

      if (parts[1] === "exchange" && req.method === "POST") {
        const { public_token, institution, kind } = await req.json();
        const k = LINK_KINDS[kind] ? kind : "bank";
        const ex = (await plaid().itemPublicTokenExchange({ public_token })).data;
        const acc = (await plaid().accountsGet({ access_token: ex.access_token })).data.accounts;
        const item = {
          item_id: ex.item_id, access_token: ex.access_token, institution: institution || "Bank",
          kind: k, scope: LINK_KINDS[k].scope,   // "networth" links never sync purchases into Spending
          accounts: mapAccounts(acc), balancesAt: new Date().toISOString(),
          cursor: null, added: new Date().toISOString(), webhook: webhookUrl(req),
        };
        await ps.setJSON("items", items.filter(i => i.item_id !== item.item_id).concat([item]));
        const result = await syncAll();
        return json(result);
      }

      if (parts[1] === "items" && req.method === "GET") { await ensureWebhooks(req, ps, items); return json({ items: items.map(publicItem) }); }

      if (parts[1] === "items" && parts[2] && req.method === "DELETE") {
        const it = items.find(i => i.item_id === parts[2]);
        if (it) { try { await plaid().itemRemove({ access_token: it.access_token }); } catch (e) { /* already gone at Plaid */ } }
        await ps.setJSON("items", items.filter(i => i.item_id !== parts[2]));
        return json({ ok: true });
      }

      if (parts[1] === "sync" && req.method === "POST") return json(await syncAll());
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    const pe = plaidError(e);
    return json({ error: pe.error_message || "Something went wrong", code: pe.error_code || null }, 500);
  }
};

export const config = { path: "/api/*" };
