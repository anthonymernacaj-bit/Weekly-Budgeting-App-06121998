// Reads a bank's purchase text ("Chase: You made a $23.45 transaction with STARBUCKS on Oct 12...")
// and pulls out the amount, where it was spent, and which card. Works with the usual US bank wording;
// anything that isn't a purchase (deposits, payments, declines, refunds, codes) is skipped.

const BANKS = [
  ["American Express", /\b(amex|american express)\b/i], ["Capital One", /\bcapital ?one\b/i], ["Chase", /\bchase\b/i],
  ["Citi", /\bciti(bank|card)?\b/i], ["Bank of America", /\b(bofa|bank of america)\b/i], ["Discover", /\bdiscover\b/i],
  ["Wells Fargo", /\bwells fargo\b/i], ["Fidelity", /\bfidelity\b/i], ["U.S. Bank", /\bu\.?s\.? bank\b/i], ["PNC", /\bpnc\b/i],
  ["TD Bank", /\btd bank\b/i], ["Synchrony", /\bsynchrony\b/i], ["Barclays", /\bbarclays\b/i], ["Ally", /\bally\b/i],
  ["SoFi", /\bsofi\b/i], ["Navy Federal", /\bnavy federal\b/i], ["USAA", /\busaa\b/i], ["Citizens", /\bcitizens\b/i],
  ["M&T", /\bm ?& ?t\b/i], ["Apple Card", /\bapple card\b/i], ["Chime", /\bchime\b/i],
];

// Declines, fraud checks and anything else where the charge didn't go through. Checked before anything else.
const DECLINED = /\b(declin\w*|dclnd|dcln|denied|not approved|wasn'?t approved|unsuccessful|could ?n[o']?t be (?:processed|completed|approved|authorized)|not authorized|unauthorized|blocked|suspicious|fraud\w*|unusual (?:activity|purchase|charge|transaction)|did you (?:make|attempt|authorize|try|recognize)|is this you|was this you|reply (?:yes|no|y|n)\b|insufficient funds|exceed(?:s|ed)? (?:your )?(?:credit )?limit|over (?:your )?(?:credit )?limit)/i;

// Texts that mention money but aren't a purchase
const NOT_PURCHASE = new RegExp([
  "refund", "return credit", "deposit", "payment (?:was |has been )?(?:received|posted|scheduled|processed)",
  "thank you for (?:your|the) payment", "payment (?:is )?due", "minimum payment", "statement", "verification", "security code",
  "one[- ]time", "passcode", "\\bcode is\\b", "credit(?:ed)? (?:of|to|for) \\$", "credited", "reversal", "reversed",
  "transfer(?:red)? (?:to|from)", "zelle", "(?:hold|charge) (?:was |has been )?(?:released|removed|canceled|cancelled)", "balance (?:is|was|has) (?:below|under|low)", "low balance", "autopay", "auto-pay",
].join("|"), "i");
const LOOKS_LIKE_PURCHASE = /\b(purchase|transaction|charge[ds]?|chrge[ds]?|chrg|hold|charging|spent|spend|debit|used|payment of|authoriz|you made|was made|you paid|paid|swiped|tapped)\b/i;

const AMOUNT = /(?:\$|\bUSD\s?)\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/gi;
// Words that end a merchant name: "STARBUCKS on Oct 12", "STARBUCKS was made", "STARBUCKS with your card"
const STOP = "(?=\\s+(?:on|was|were|has|have|for|using|with|from|in|via|is|exceeds|exceeded|by|ending|today|yesterday|at\\s+\\d|card|and|authorized|approved|\\d{1,2}/\\d{1,2})\\b|\\s+[a-z]+\\s?:|\\s*[;!|]|[.,]\\s|[.,]?\\s*$|\\s+-\\s|\\s*\\()";
const MERCHANT_RES = [
  new RegExp("\\b(?:merchant|description|desc|where|location)\\s*[:\\-]\\s*(.+?)" + STOP, "gi"),
  new RegExp("(?:\\bat|@)\\s*(.+?)" + STOP, "gi"),
  new RegExp("\\bwith\\s+(?!your\\b|you\\b|card\\b|a\\b|the\\b)(.+?)" + STOP, "gi"),
  new RegExp("\\b(?:to|from|by)\\s+(?!your\\b|you\\b|card\\b|the\\b|a\\b|account\\b)(.+?)" + STOP, "gi"),
];
const CARD = [/\bcard\s*\((\d{4})\)/i, /\b(?:ending|ends)(?:\s+in)?\s*[:#]?\s*(?:[x*•.]+\s*)?(\d{4})\b/i, /\blast\s+(?:4|four)(?:\s+digits)?(?:\s+of)?[^\d]{0,20}(\d{4})\b/i, /[x*•]{1,4}\s?(\d{4})\b/i, /\b(?:card|acct|account)\s*(?:#|no\.?|number)?\s*[:#]?\s*(\d{4})\b/i];
const PREFIX = /^(?:sq|tst|py|sp|pp|ddbr|dd|ic|in|bt|cke|fs|ls|pos|ach|chk|dbt|debit|purchase)\s?\*\s?/i;
const BAD_NAME = /^(?:your|card|you|this|that|it|its)\b|^\d/i;

const tidy = s => {
  let n = String(s).replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”.,:;!-]+$/g, "").trim();
  for (let i = 0; i < 2; i++) n = n.replace(PREFIX, "");
  n = n.replace(/\s?\*\s?(?=[a-z]*\d)[a-z0-9]{4,}$/i, "").replace(/\s?\*\s?/g, " ").replace(/\s+(?:#\s?\d+|store\s*#?\s*\d+|\d{4,})$/i, "").replace(/\s+[A-Z]{2}$/,"").trim();   // trailing store numbers, state codes
  if (n.length > 40) n = n.slice(0, 40).replace(/\s+\S*$/, "");
  // ALL CAPS reads better in title case: STARBUCKS COFFEE -> Starbucks Coffee
  if (n && n === n.toUpperCase() && /[A-Z]/.test(n)) n = n.toLowerCase().replace(/(^|[\s&/(-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/(?<=\s)(Of|And|The|At|On)(?=\s)/g, w => w.toLowerCase());
  return n;
};

/* "Oct. 11, 2026", "October 11 2026", "10/11/2026", "10/11/26" -> 2026-10-11 */
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, "0");
function dateIn(text) {
  let m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(text);
  if (m) return `${m[3]}-${pad(MON[m[1].toLowerCase()])}-${pad(m[2])}`;
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/.exec(text);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}

/* Capital One's purchase text, read exactly:
   "Capital One: A chrge or hold for $10.83 on Oct. 11, 2026 was placed on your Venture Credit Card (5010) at Spirit Halloween. Std carrier chrges apply" */
const CAPONE = /^capital one:\s*a\s+ch(?:a)?rge\s+or\s+hold\s+(?:for|of)\s+\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s+(?:on\s+(.+?)\s+)?was\s+placed\s+on\s+your\s+(.+?)\s*\((\d{4})\)\s+at\s+(.+?)\s*(?:\.\s+(?:std|msg|reply|text|to stop|data)\b.*|\.?)$/i;
function parseCapitalOne(text) {
  const m = CAPONE.exec(text);
  if (!m) return { ok: false, skipped: "not a purchase" };   // any other Capital One text (payments, declines, reminders) is left alone
  const amount = Math.round(parseFloat(m[1].replace(/,/g, "")) * 100) / 100;
  if (!(amount > 0)) return { ok: false, skipped: "no amount" };
  return { ok: true, amount, name: tidy(m[5]) || "Card purchase", account: `Capital One ••${m[4]}`, bank: "Capital One", last4: m[4], card: m[3].trim(), date: m[2] ? dateIn(m[2]) : null, exact: true };
}

export function parseAlert(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, skipped: "empty" };
  if (DECLINED.test(text)) return { ok: false, skipped: "declined" };
  if (/^capital ?one\b/i.test(text)) return parseCapitalOne(text);
  if (NOT_PURCHASE.test(text)) return { ok: false, skipped: "not a purchase" };
  if (!LOOKS_LIKE_PURCHASE.test(text)) return { ok: false, skipped: "not a purchase" };

  // Amount: the first dollar figure that isn't a balance or limit
  let amount = null, amountAt = -1;
  for (const m of text.matchAll(AMOUNT)) {
    const before = text.slice(Math.max(0, m.index - 28), m.index).toLowerCase();
    if (/(balance|limit|available|remaining|credit line)\W*(is|of|:)?\W*$/.test(before) || /(balance|limit)/.test(before.slice(-14))) continue;
    amount = Math.round(parseFloat(m[1].replace(/,/g, "")) * 100) / 100; amountAt = m.index; break;
  }
  if (!(amount > 0)) return { ok: false, skipped: "no amount" };

  // Merchant: the earliest "at X" / "with X" / "Merchant: X" that reads like a name
  let best = null;
  MERCHANT_RES.forEach((re, rank) => {
    for (const m of text.matchAll(re)) {
      const name = tidy(m[1]);
      if (!name || BAD_NAME.test(name) || /^\d{1,2}:\d{2}/.test(m[1]) || /\$\d/.test(name) || name.length < 2) continue;
      const score = rank === 0 ? -1 : m.index;   // an explicit "Merchant:" label always wins
      if (!best || score < best.score) best = { name, score };
      break;
    }
  });
  const name = best ? best.name : "Card purchase";

  let bank = null, bankAt = Infinity;
  for (const [label, re] of BANKS) { const m = re.exec(text); if (m && m.index < bankAt && !(best && best.name.toLowerCase().includes(m[0].toLowerCase()))) { bank = label; bankAt = m.index; } }
  let last4 = null;
  for (const re of CARD) { const m = re.exec(text); if (m) { last4 = m[1]; break; } }
  const account = [bank || (last4 ? "Card" : "Text alert"), last4 ? `••${last4}` : ""].filter(Boolean).join(" ");

  return { ok: true, amount, name, account, bank, last4, date: dateIn(text) };
}

/* Loose name match: "SQ *Blue Bottle Coffee" and "Blue Bottle" are the same place */
const GENERIC = new Set(["the", "and", "store", "shop", "inc", "llc", "com", "www", "card", "purchase", "payment", "pos", "debit", "online", "market", "new", "york", "usa"]);
const tokens = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w));
export function similarName(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return false;
  return A.some(x => B.some(y => x === y || (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x)))));
}

/* A first guess at the category from the name, used only until you've categorized that place yourself */
const GUESS = [
  ["Gas", /\b(shell|exxon|mobil|exxonmobil|bp|sunoco|chevron|citgo|speedway|gulf|valero|marathon|hess|getty|sinclair|phillips 66|conoco|arco|76|fuel|gas)\b/i],
  ["Groceries", /\b(stop ?& ?shop|shoprite|shop rite|trader joe'?s?|whole foods|aldi|kroger|wegmans|key food|c-?town|food bazaar|stew leonard'?s?|fairway|morton williams|gristedes|associated|western beef|h ?mart|lidl|safeway|publix|food lion|giant|acme|hannaford|price ?rite|instacart|fresh direct|freshdirect|grocery|groceries|supermarket)\b/i],
  ["Dining Out", /\b(starbucks|dunkin|mcdonald'?s?|chipotle|sweetgreen|shake shack|burger|pizza|pizzeria|cafe|caf[eé]|coffee|bagel|deli|diner|grill|kitchen|restaurant|bar|tavern|taqueria|sushi|ramen|wings|chick-?fil-?a|wendy'?s|taco bell|panera|popeyes|subway|five guys|domino'?s|doordash|uber ?eats|grubhub|seamless|caviar|postmates)\b/i],
];
export function guessCategory(name, names) {
  const has = n => names.includes(n);
  for (const [cat, re] of GUESS) if (re.test(name) && has(cat)) return cat;
  return null;
}

/* Places where the first charge is only a hold and the final amount comes later (a gas pump, a hotel, a rental, a ride) */
const SETTLES = /\b(shell|exxon|mobil|exxonmobil|bp|sunoco|chevron|citgo|speedway|gulf|valero|marathon|hess|getty|sinclair|conoco|arco|wawa|quickchek|fuel|gas|petro|hotel|inn|suites|resort|marriott|hilton|hyatt|sheraton|westin|airbnb|vrbo|hertz|avis|enterprise|budget|national|alamo|zipcar|turo|uber|lyft|tesla supercharger|chargepoint|evgo|parking|parkwhiz|spothero|ez ?pass|e-?zpass)\b/i;
export const holdsThenSettles = name => SETTLES.test(String(name || ""));
