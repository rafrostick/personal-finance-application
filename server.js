// Get There — Plaid backend
// Run: node server.js
// Requires: npm install express cors dotenv plaid helmet express-rate-limit

require("dotenv").config();
const https = require("https");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require("plaid");

const app = express();
// Security headers — CSP mirrors the meta tag in index.html
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "https://cdn.plaid.com", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      scriptSrc:  ["'self'", "https://cdn.plaid.com", "https://cdnjs.cloudflare.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https://localhost:3001", "https://127.0.0.1:3001", "https://api.anthropic.com", "https://*.plaid.com"],
      frameSrc:   ["https://*.plaid.com"],
      imgSrc:     ["'self'", "https://*.plaid.com", "data:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS: localhost only
app.use(cors({ origin: 'https://localhost:3001', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));

app.use(express.json({ limit: '10kb' }));
app.use(express.static(__dirname + '/public'));

// Rate limiting — 60 requests/minute per IP
const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests — please wait.' } });
app.use(limiter);

// Tighter limit on token exchange
const exchangeLimiter = rateLimit({ windowMs: 60_000, max: 10, message: { error: 'Too many token exchanges — please wait.' } });

// ── Plaid client ──────────────────────────────────────────────────────────────
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || "sandbox"],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// ── Persistent token store ───────────────────────────────────────────────────
const TOKENS_FILE = './tokens.json';
function loadTokens() {
  try { if (fs.existsSync(TOKENS_FILE)) return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
  catch(e) { console.error('Failed to load tokens:', e.message); }
  return {};
}
function saveTokens(t) {
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2), 'utf8'); }
  catch(e) { console.error('Failed to save tokens:', e.message); }
}
const accessTokens = loadTokens();
console.log(`   Loaded ${Object.keys(accessTokens).length} linked account(s) from disk.`);

// ── 1. Create a link_token ────────────────────────────────────────────────────
app.post("/api/create_link_token", async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: "get-there-user" },
      client_name: "Get There",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("create_link_token error:", err.response?.data || err.message);
    res.status(500).json({ error: 'Could not create link session. Check your Plaid credentials.' });
  }
});

// ── 2. Exchange public_token → access_token ───────────────────────────────────
app.post("/api/exchange_token", exchangeLimiter, async (req, res) => {
  try {
    const { public_token, institution_name } = req.body;
    // Validate public_token format before sending to Plaid
    if (typeof public_token !== 'string' || !/^[a-zA-Z0-9\-_]+$/.test(public_token) || public_token.length < 10) {
      return res.status(400).json({ error: 'Invalid public_token format.' });
    }
    // Sanitize institution name
    const safeName = typeof institution_name === 'string'
      ? institution_name.replace(/[\x00-\x1F\x7F]/g,'').trim().slice(0,100) || 'Unknown Bank'
      : 'Unknown Bank';

    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    // Persist to disk so tokens survive server restarts
    accessTokens[itemId] = { accessToken, institution_name: safeName };
    saveTokens(accessTokens);
    console.log(`Linked: ${safeName} (${itemId})`);

    res.json({ item_id: itemId, institution_name: safeName });
  } catch (err) {
    console.error("exchange_token error:", err.response?.data || err.message);
    res.status(500).json({ error: 'Token exchange failed.' });
  }
});

// ── 3. Fetch transactions ─────────────────────────────────────────────────────
app.get("/api/transactions", async (req, res) => {
  try {
    const allTransactions = [];

    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    for (const [itemId, { accessToken, institution_name }] of Object.entries(accessTokens)) {
      let added = [];
      let cursor = null;
      let hasMore = true;
      let pages = 0;
      const MAX_PAGES = 20;

      // Use /transactions/sync for reliable pagination
      while (hasMore && pages < MAX_PAGES) {
        pages++;
        const params = { access_token: accessToken };
        if (cursor) params.cursor = cursor;

        const syncResp = await plaidClient.transactionsSync(params);
        const data = syncResp.data;

        added = added.concat(data.added);
        hasMore = data.has_more;
        cursor = data.next_cursor;
      }

      // Map Plaid transactions to Get There format
      const mapped = added
        .filter((t) => !t.pending)
        .map((t) => ({
          id: t.transaction_id,
          date: t.date,
          desc: t.merchant_name || t.name,
          amount: Math.abs(t.amount),
          type: t.amount > 0 ? "expense" : "income",
          cat: mapCategory(t.personal_finance_category?.primary || t.category?.[0]),
          account: institution_name,
          raw_category: t.personal_finance_category?.primary,
        }));

      allTransactions.push(...mapped);
    }

    // Sort newest first
    allTransactions.sort((a, b) => b.date.localeCompare(a.date));
    res.json({ transactions: allTransactions });
  } catch (err) {
    console.error("transactions error:", err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch transactions.' });
  }
});

// ── 4. List linked accounts ───────────────────────────────────────────────────
app.get("/api/linked_accounts", async (req, res) => {
  const accounts = [];
  for (const [itemId, { accessToken, institution_name }] of Object.entries(accessTokens)) {
    try {
      const resp = await plaidClient.accountsGet({ access_token: accessToken });
      resp.data.accounts.forEach((acct) => {
        accounts.push({
          id: acct.account_id,
          name: `${institution_name} — ${acct.name}`,
          type: mapAccountType(acct.type),
          balance: acct.balances.current ?? 0,
          subtype: acct.subtype,
        });
      });
    } catch (err) {
      console.error(`accounts error for ${institution_name}:`, err.response?.data || err.message);
    }
  }
  res.json({ accounts });
});

// ── 5. List linked items (for frontend state restore on page load) ────────────
app.get("/api/linked_items", (req, res) => {
  const items = Object.entries(accessTokens).map(([item_id, { institution_name }]) => ({
    item_id,
    name: institution_name,
  }));
  res.json({ items });
});

// ── Catch-all 404 ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled:`, err.message);
  res.status(500).json({ error: 'An unexpected error occurred.' });
});

// ── Category mapper ───────────────────────────────────────────────────────────
function mapCategory(plaidCat) {
  if (!plaidCat) return "Other expense";
  const map = {
    FOOD_AND_DRINK: "Food",
    TRAVEL: "Transport",
    TRANSPORTATION: "Transport",
    SHOPS: "Shopping",
    GENERAL_MERCHANDISE: "Shopping",
    RENT_AND_UTILITIES: "Utilities",
    HOME_IMPROVEMENT: "Housing",
    MEDICAL: "Healthcare",
    HEALTHCARE: "Healthcare",
    ENTERTAINMENT: "Entertainment",
    EDUCATION: "Education",
    INCOME: "Salary",
    TRANSFER_IN: "Other income",
    TRANSFER_OUT: "Other expense",
    LOAN_PAYMENTS: "Housing",
    PERSONAL_CARE: "Healthcare",
    GENERAL_SERVICES: "Other expense",
    GOVERNMENT_AND_NON_PROFIT: "Other expense",
    BANK_FEES: "Other expense",
  };
  return map[plaidCat.toUpperCase()] || "Other expense";
}

function mapAccountType(plaidType) {
  const map = { depository: "Bank", credit: "Credit", investment: "Investment", loan: "Credit" };
  return map[plaidType] || "Bank";
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const httpsOptions = {
  key: fs.readFileSync('./localhost+1-key.pem'),
  cert: fs.readFileSync('./localhost+1.pem'),
};
https.createServer(httpsOptions, app).listen(PORT, "127.0.0.1", () => {
  console.log(`\n✅ Get There backend running at https://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.PLAID_ENV || "sandbox"}`);
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    console.warn("\n⚠️  PLAID_CLIENT_ID or PLAID_SECRET not set — check your .env file!\n");
  }
});