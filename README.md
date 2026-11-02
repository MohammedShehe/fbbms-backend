# FBBMS v3 – Backend (Node.js + Express + MySQL)

## Set up
1. Create a NEW database (your legacy data stays untouched):
   `CREATE DATABASE fbbms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
2. `cp .env.example .env` and fill it (DB, `JWT_SECRET`, Zoho SMTP for sign-in codes, Cloudinary credentials, `ALLOWED_ORIGINS`).
3. `npm install`
4. `npm run migrate`   → creates the tables **and upgrades an existing v2 database in place** (safe to run repeatedly; take a backup first)
5. `npm run seed`      → creates ZanLux + Four Brothers Sports Center, the Developer (MO11) and the founder Super Admin
   (passwords come from `SEED_*_PASSWORD` or are generated and printed once; you must change them at first sign-in)
6. `npm start`

Product photos are uploaded straight to **Cloudinary** (folder `fbbms/<shop>/products`); nothing is stored on the server disk.
Sign-in codes are sent through **Zoho SMTP** (`smtp.zoho.in`, port 587 STARTTLS). The sender must be the same mailbox as `SMTP_USER`.

## Roles
* **Developer** (global): all businesses, create shops from templates, add/disable Super Admins, platform theme, audit.
* **Super Admin** (per business): everything in the shop + team, permissions, reports, audit, settings, website content.
* **Sub Admin** (shopkeeper): only what the Super Admin grants (see `lib/permissions.js`).

## Anti-fraud design
Sales cannot be edited or deleted – only *voided* (reason + who + when, stock returned, shown to the Super Admin).
Receipt numbers are sequential per shop. Stock is locked and deducted in the same DB transaction as the sale and
every change is a permanent stock-ledger row. Reports include a stock reconciliation (ledger vs. shelf), voids,
discount and price-override flags, and a full audit trail.

## What is new in v3
Everything below is a **feature module** the platform Developer switches on/off per business (Developer console → *Feature modules*); Super Admins only see what is enabled for them.

| Module | What it gives the business |
|---|---|
| Suppliers & purchase orders | Supplier records and balances, purchase orders, partial receiving (weighted-average cost, expiry), supplier payments |
| Customers & loyalty (CRM) | Profiles, history, segments, birthdays, credit sales with debt repayments, loyalty points earn/redeem |
| Refunds & exchanges | Return against a sale, restock, refund money or exchange for other goods (with limits for shopkeepers) |
| Cash management | Open/close the till, cash in/out, expected vs counted cash with variance alerts, closing report |
| Finance & tax | Income statement, cash flow, tax report, receivables / payables |
| Business Health Monitor | **Transparent** score (fixed formulas shown in the UI, no AI), risk flags, recommendations, sales forecast |
| Alerts & summaries | In-app notifications (low stock, big discounts, voids, cash variance), daily/weekly summaries, optional email |
| AI assistant (off by default) | Questions answered from the business's own data through permission-scoped tools |
| Public API & webhooks (off by default) | API keys, scopes, rate limits, idempotency, signed webhooks — see `docs/PUBLIC_API.md` |

Also: per-business **timezone, date format, tax and currency** (nothing is hard-coded to EAT/TZS any more), barcode and expiry on products, multi-payment/partial-payment sales, branch groups (compare branches, transfer stock), session list with remote sign-out, login history, database backups, maintenance mode.

## The Developer controls everything from the UI
Developer console → **AI settings** (provider, base URL, model, API key — stored encrypted, never displayed again —, limits, test button, usage monitor), **Feature modules**, **API & integrations** (platform policy, every key and webhook), **System & backups** (health, errors, maintenance, backups, branch groups), **Security & sessions**.

### AI (Groq)
Enter the key in *Developer console → AI settings*: provider **Groq**, model **`openai/gpt-oss-20b`**, base URL `https://api.groq.com/openai/v1`. The key is encrypted with `SETTINGS_KEY` (set it in `.env` before saving a key). `GROQ_API_KEY` in `.env` is only a fallback.
The assistant can only answer by calling read-only tools that respect the signed-in user's permissions; it is instructed never to estimate or invent figures.

## Public API for websites
`docs/PUBLIC_API.md` is the integration guide (keys, scopes, endpoints, errors, idempotency, webhooks + signature verification, browser/Node/PHP examples). Base path: `/api/v1`. The legacy `/api/public/:slug` routes remain.

## Scheduler & backups
A built-in scheduler sends daily/weekly summaries, low-stock/expiry digests, posts recurring expenses and writes gzip SQL backups to `BACKUP_DIR` (and prunes old ones). Run **one** instance, or set `DISABLE_SCHEDULER=true` on extra instances.

## Upgrading from v2
1. Back up the database. 2. Replace the code (keep your `.env`, and add the new keys from `.env.example`). 3. `npm install`. 4. `npm run migrate`. 5. Restart. Existing sales are back-filled into the new payments table automatically.
