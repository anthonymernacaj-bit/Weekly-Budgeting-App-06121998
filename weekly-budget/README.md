# Weekly Budget

A weekly spending tracker with Needs/Wants budgets, bills, and month and year views.
Debit and credit card purchases sync automatically through Plaid; you can still add, edit and delete entries by hand.

## What's in here

```
public/index.html                  the whole app (one file)
netlify/functions/api.mjs          /api/data (your budget) and /api/plaid/* (linked accounts)
netlify/functions/sync-scheduled.mjs  pulls new transactions every 3 hours
netlify/lib/budget.mjs             Plaid client, storage, and the sync logic
```

Your budget and purchases are stored in Netlify Blobs, so every device you open the app on sees the same data.
Plaid access tokens are stored separately on the server and are never sent to the browser.

## Deploy

1. Push this folder to a new GitHub repo (private is best).
2. In Netlify: **Add new site → Import an existing project → GitHub**, pick the repo. The build settings come from `netlify.toml`; there's no build command.
3. In **Site configuration → Environment variables**, add everything from `.env.example`:
   - `PLAID_CLIENT_ID`, `PLAID_SECRET` from the Plaid dashboard (the secret must match `PLAID_ENV`)
   - `PLAID_ENV`: `sandbox` to test with fake banks, `production` for your real cards
   - `APP_PASSCODE`: a long passcode. The app asks for it once per device; every request to your data and to Plaid needs it
   - `SYNC_START_DATE`: `2026-09-01`. Nothing earlier is pulled in
4. Redeploy so the functions pick up the variables.
5. Open the site, enter your passcode, then **Profile → Restore from a backup** and pick `weekly-budget-backup.json` to bring in your budget and bills.
6. **Profile → Connect a bank or card**. Do it once for your debit card's bank and once for your credit card's bank (or once if they're the same bank).

In sandbox, Plaid's test login is `user_good` / `pass_good`.

## How syncing works

- New transactions come in every 3 hours, whenever you open the app (if it's been 15+ minutes), and when you tap **Sync now**.
- Pending charges show as "Pending" and are replaced by the posted version; your edits carry over.
- If you logged a purchase by hand and the same amount shows up from your bank within 3 days, they're merged instead of doubled.
- Card payments, transfers, income, rent, and anything whose name matches one of your bills are marked "Not counted", since bills are already tracked separately. Open any purchase to flip "Count this toward spending".
- Deleting a synced purchase keeps it deleted; later syncs won't bring it back.
- Categories come from the places you've tagged before, then from Plaid's category (groceries, gas, restaurants), then Misc.

## Going to production with real cards

In the Plaid dashboard, request Production access for the Transactions product. Many large banks (Chase, Bank of America, Capital One and others) use OAuth and need the extra institution access steps Plaid lists under **Link → OAuth**; until that's approved those banks may not appear in Link.

## Local development

```
npm install
npx netlify dev
```

`netlify dev` serves the app and functions together and reads variables from a local `.env` file (copy `.env.example`).
