// All app requests: /api/data (your budget) and /api/plaid/* (linked accounts).
import { dataStore, plaidStore, json, authorized, plaid, plaidError, syncAll, publicItem } from "../lib/budget.mjs";

const DOC_ID = /^(settings|tombstones|m-\d{4}-\d{2})$/;

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  if (!process.env.APP_PASSCODE) return json({ error: "Set APP_PASSCODE in Netlify's environment variables." }, 500);
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);

  try {
    /* ---------- budget data ---------- */
    if (parts[0] === "data") {
      const ds = dataStore();
      if (req.method === "GET" && !parts[1]) {
        const { blobs } = await ds.list();
        const docs = {};
        for (const b of blobs) if (DOC_ID.test(b.key)) docs[b.key] = await ds.get(b.key, { type: "json" });
        return json({ docs });
      }
      const id = parts[1];
      if (!DOC_ID.test(id || "")) return json({ error: "bad document id" }, 400);
      if (req.method === "PUT") { const body = await req.json(); await ds.setJSON(id, body); return json({ ok: true }); }
      if (req.method === "DELETE") { await ds.delete(id); return json({ ok: true }); }
    }

    /* ---------- Plaid ---------- */
    if (parts[0] === "plaid") {
      const ps = plaidStore();
      const items = (await ps.get("items", { type: "json" })) || [];

      if (parts[1] === "link-token" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const update = body.item_id ? items.find(i => i.item_id === body.item_id) : null;
        const r = await plaid().linkTokenCreate({
          user: { client_user_id: "weekly-budget-owner" },
          client_name: "Weekly Budget",
          country_codes: ["US"], language: "en",
          ...(update ? { access_token: update.access_token } : { products: ["transactions"], transactions: { days_requested: 90 } }),
        });
        return json({ link_token: r.data.link_token });
      }

      if (parts[1] === "exchange" && req.method === "POST") {
        const { public_token, institution } = await req.json();
        const ex = (await plaid().itemPublicTokenExchange({ public_token })).data;
        const acc = (await plaid().accountsGet({ access_token: ex.access_token })).data.accounts;
        const item = {
          item_id: ex.item_id, access_token: ex.access_token, institution: institution || "Bank",
          accounts: acc.map(a => ({ id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })),
          cursor: null, added: new Date().toISOString(),
        };
        await ps.setJSON("items", items.filter(i => i.item_id !== item.item_id).concat([item]));
        const result = await syncAll();
        return json(result);
      }

      if (parts[1] === "items" && req.method === "GET") return json({ items: items.map(publicItem) });

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
