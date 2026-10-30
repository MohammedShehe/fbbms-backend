# FBBMS v2 – Backend (Node.js + Express + MySQL)

## Set up
1. Create a NEW database (your legacy data stays untouched):
   `CREATE DATABASE fbbms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
2. `cp .env.example .env` and fill it (DB, `JWT_SECRET`, Zoho SMTP for sign-in codes, Cloudinary credentials, `ALLOWED_ORIGINS`).
3. `npm install`
4. `npm run migrate`   → creates the tables
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
