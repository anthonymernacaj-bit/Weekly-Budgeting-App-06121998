# Weekly Budget

A weekly spending tracker with Needs/Wants budgets, bills, and month and year views.
Debit and credit card purchases sync automatically through Plaid; you can still add, edit and delete entries by hand.

## What's in here

```
public/index.html                  the whole app (one file)
netlify/functions/api.mjs          /api/data (your budget) and /api/plaid/* (linked accounts)
netlify/functions/sync-scheduled.mjs  pulls new transactions every 3 hours
netlify/lib/budget.mjs             Plaid client, storage, and the sync logic
netlify/lib/textalert.mjs          reads your bank's purchase texts (amount, place, card)
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

- New transactions come in as soon as Plaid has them: Plaid notifies `/api/plaid/webhook`, which syncs right away. The every-3-hours check and opening the app are backups.
- Purchases your bank hasn't processed yet are included and marked **Hold**. How soon a card swipe shows up depends on how often Plaid hears from your bank (usually a few times a day); bank texts (below) are faster.
- A hold is replaced by the processed version once the bank finishes it; your edits carry over.
- If you logged a purchase by hand and the same amount shows up from your bank within 3 days, they're merged instead of doubled.
- Credit card payments, transfers and income are marked "Not counted". Open any purchase to flip "Count this toward spending".
- Rent, utilities, phone and loan payments come in as "Unassigned". Assign one to a bill (Rent, Student Loans, ...) and that payee is assigned automatically from then on.
- Bills are part of the monthly budget (Needs, Wants, Bills). A bill only counts as paid once a payment is assigned to it.
- Each bill has a frequency: weekly, biweekly, monthly, bimonthly (every 2 months), quarterly or yearly. The amount is what one bill costs. Weekly and biweekly bills follow your pay schedule from Goals, so a month with 3 biweekly paydays budgets 3 of that bill. Bimonthly, quarterly and yearly bills are split into an even monthly share.
- Deleting a synced purchase keeps it deleted; later syncs won't bring it back.
- Categories come from the places you've tagged before, then from Plaid's category (groceries, gas, restaurants), then Misc.

## Purchases from bank texts (iPhone)

Plaid only sees a purchase once your bank reports it, which can take hours. Your bank texts you the moment your card is used, so an iPhone Shortcut can send each of those texts to the app, and the purchase shows up in Spending within seconds.

Set it up once in the Shortcuts app (the same steps are in **Profile → Purchases from bank texts**, with the address ready to copy):

1. **Automation → + → Message.**
2. **Sender:** your bank's alert number. Save it as a contact first (like "Chase Alerts") so you can pick it. Or use **Message Contains** with a phrase only purchase texts have. For Capital One that's `chrge or hold`, so declines and payment texts never run it.
3. **Run Immediately**, then **Next → New Blank Automation**.
4. Add **Get Contents of URL** with `https://<your-site>.netlify.app/api/text`.
5. Open its options: **Method** POST, **Headers** `x-app-passcode` = your `APP_PASSCODE`, **Request Body** JSON with a Text field `text` set to **Shortcut Input → Content**.
6. **Done.** Make one automation per bank if you have more than one.

How it works:

- The app reads the amount, the place, the card and the day from the text. Capital One's purchase text is read exactly ("A chrge or hold for $10.83 on Oct. 11, 2026 was placed on your Venture Credit Card (5010) at Spirit Halloween"); any other Capital One text is left alone. Other banks' usual wording (Chase, Amex, Citi, Bank of America, Discover, Wells Fargo, Fidelity and most US banks) is read too. Paste one of your bank's texts into **Profile → Try one of your bank's texts** to check it.
- Declined charges, fraud checks ("Did you attempt…? Reply YES or NO"), over-limit and insufficient-funds texts are never added, even if they mention an amount and a store. Texts that aren't purchases (deposits, payments, refunds, released holds, verification codes, low-balance warnings) are skipped. The same text arriving twice is only added once.
- The purchase goes on the day the text says, so a text that arrives after midnight still lands on the right day.
- A text purchase is a **Hold**: it counts toward your spending right away, and the week's total says how much of it is on hold. It gets a category from places you've categorized before, then from the name (gas stations, grocery stores, restaurants), then Misc. Change it and that place keeps your name and category next time.
- When the bank processes the charge, Plaid's version confirms the hold and takes its place, with the final amount: the same amount within 3 days; the same place within 4 days with up to 35% more (a tip); or any amount at places where the first charge is only a hold (gas pumps, hotels, car rentals, rides, $1 card checks). Open a confirmed purchase to see what the hold was. If you edited the hold, your name and category stay. If the bank's version got there first, the text is matched to it instead of being added again.
- A hold that still isn't processed after 5 days says so when you open it, in case the charge was canceled.
- Saving from the app never drops a text purchase that arrived after you opened it.

## Net Worth

Open **Net Worth** and answer the setup questions (you can redo them any time from the gear on that tab).

- Open the breakdown (tap your net worth) to see each category, with linked accounts grouped by institution (Fidelity, Charles Schwab, Chase, TD Bank…).
- Tap **Edit** in the breakdown to change things; **Done** puts it back. In Edit, every asset and liability has a pencil to type in an amount, each linked account has its own edit button, and a **+** under Investments, Bank accounts, Credit cards and each loan links another institution there. A bank account or card you add with **+** can count toward Net Worth only, or also sync its purchases into Spending.
- Every asset and liability can be typed in. If that category has linked accounts, you're warned first: your typed amount pauses those linked balances in Net Worth (they stay linked, and banks and cards keep syncing purchases into Spending). Tap **Reactivate linked accounts** under the category to switch back.
- Each linked account has its own edit button. It shows the account's details and lets you update the connection through Plaid (sign in again, add or remove accounts) or unlink it.
- Investment accounts, and home or car loans you link there, are **Net Worth only**. The app saves balances for them and never pulls their transactions, so nothing from them shows up in Spending.
- Banks and credit cards you linked in Spending show up in Net Worth automatically. Once one is there, the bank and card questions offer **Link another**, which adds one that only shows up in Net Worth (its purchases stay out of Spending). You can still link one that syncs into Spending from the link under that button.
- Student loans can be typed in or linked through your loan servicer.
- If you type in an amount for a home or car loan and also link that lender, the typed amount is used, so the loan is never counted twice. Clear it to go back to the linked balance.
- Balances refresh with every sync (every 3 hours, and when you open the app).
- **What you own** is a pie of what you'd keep: home equity and car equity (each shown as value − loan), investments and bank accounts, in shades of blue. It appears once your net worth is above zero; a home or car you owe more on than it's worth is left out.
- **Over time** charts your net worth day by day. The server saves a point every day on its own (with each 3-hour sync, and right after you change an amount), using your time zone from `TIME_ZONE` (New York by default).

## Goals

Set your pay schedule (last payday, how often you're paid, take-home pay per paycheck), then add goals: pay off a debt or save for something.

- **What's available each month.** Your paychecks that month (a biweekly month can have 3), minus that month's Bills from Spending, is what's available for goals. Turn on "Also set aside my needs and wants budget" to subtract those too. Step between months with the arrows on the top card.
- **Debts paid by a bill.** A debt can be tied to one of your Spending bills (picked for you when the names match, like Car loan). The roadmap then shows the bill as the **Required** payment and what you add on top as **Extra**. Monthly bills come out of the month's first paycheck; weekly and biweekly bills are spread over the month's paychecks.
- **Plan by a finish date or by an amount.** Give a finish date and the app works out the extra per paycheck, or give an amount per paycheck and it works out the finish date.
- **One after another.** A goal can start after another goal. Its dates follow that goal's finish date, so paying the first one off sooner moves the next one up. If the first goal's last extra payment is smaller than its usual extra, the next goal starts on that same paycheck, with its extra reduced by that last payment.
- **Per paycheck or per month.** The top card switches between one paycheck (its share of the month's bills) and the whole month.
- **Change any paycheck.** Tap an amount in the roadmap to change it for that paycheck; the rest of the plan adjusts.
- **Checking off a payday** takes that payment (and the interest up to then) out of the goal's amount left. A payday checked off early stays on the roadmap as "Done early" (tap it again to undo the latest one) and goes away once its date passes. Each goal keeps its original amount, so the progress bar shows how much of it is gone. Edit a goal to correct the amount left on its own, without changing the original.
- Debts can include an interest rate (APR); interest is added between paydays and the plan accounts for it.
- **Single or Multiple.** A Multiple goal holds several debts (or several things to save for) that share one amount per paycheck, the pool. Each item can start on its own date and is planned one of three ways: **Even share** (splits what's left in the pool), **Fixed amount** (a set amount every paycheck), or **Finish by** (gets what it needs to reach zero by that date). Fixed amounts and dated items are covered first, the rest is split evenly, and anything still left goes to dated items so they finish early (highest-rate debts first). Leave the pool empty when every item has a date or an amount, and the pool is exactly what they need.
- **Alerts.** If the pool can't get every dated item there on time, the goal says which items run late and how much per paycheck it would take. If some paychecks can't cover every item's share, it says how far short and what amount covers everything. Items running behind get any spare money first, including extra you add to a single paycheck.
- Once an item in a Multiple goal is paid off, the items still going share the whole pool from then on, whatever way each is planned.
- A Multiple goal's roadmap shows each payday with a column for every item. Tap an item's amount to change it for that paycheck. Amounts you set stay exactly as set; money you free up goes to the unedited goal on track to finish soonest, and money you add comes from the one finishing last. Setting every item but one to $0 gives that one the whole pool (on a paycheck shared with the goal before, the pool minus the earlier goal's last payment). Check paydays off in order.
- A payday you changed says **Edited** under its date. Tap it to see what each changed item was and what it is now, with **Clear edits** to undo that payday. Under "Edited", "$X remaining" means the pool has money nobody is using that paycheck, and "$X over" means your amounts add up to more than the pool.
- Plans look up to 40 years ahead, so large goals at a modest amount per paycheck still get a finish date.
- A Multiple goal can also start after another goal. Every item starts when that goal finishes (items don't have their own start dates then), its finish-by dates move with it, and it can share the earlier goal's last paycheck the same way a Single goal does.
- "Twice a month" means the 15th and the last day of the month.

## Going to production with real cards

In the Plaid dashboard, request Production access for the Transactions product. For Net Worth, also request **Investments** (brokerage and retirement accounts) and **Liabilities** (mortgages). Car loans link through Transactions. Many large banks (Chase, Bank of America, Capital One and others) use OAuth and need the extra institution access steps Plaid lists under **Link → OAuth**; until that's approved those banks may not appear in Link.

## Local development

```
npm install
npx netlify dev
```

`netlify dev` serves the app and functions together and reads variables from a local `.env` file (copy `.env.example`).
