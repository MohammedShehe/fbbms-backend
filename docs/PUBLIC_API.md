# FBBMS Public API (v1) — Integration Guide

Connect any website or app to a business running on FBBMS: show its live catalogue, take customer orders, let customers track an order, register customers, and receive real-time events through webhooks.

- **Base URL:** `https://<your-backend-host>/api/v1` (for example `https://backend.fourbrothers.online/api/v1`)
- **Format:** JSON over HTTPS. Send `Content-Type: application/json` on `POST` requests.
- **Auth:** an API key created by the business's Super Admin (see "Get an API key").

---

## 1. Get an API key

1. The platform Developer switches on the **Public API & webhooks** module for the business (Developer console → *Feature modules*).
2. The business Super Admin opens **API & webhooks** in the dashboard and clicks **Create key**.
3. Choose a name (e.g. "Website"), the permissions (scopes) the key needs, and the **allowed websites** (origins) that may use it, e.g. `https://zanlux.online`.
4. Copy the key. It looks like `fbk_live_…` and is **shown only once**. FBBMS stores only a hash, so a lost key must be replaced by a new one.

Send the key on every request in either header:

```
X-API-Key: fbk_live_xxxxxxxxxxxxxxxx
Authorization: Bearer fbk_live_xxxxxxxxxxxxxxxx
```

> **Security:** a key placed in browser JavaScript is visible to anyone who opens the page. That is acceptable for read-only/public scopes **if you restrict the key to your website's origin**, and the permissions below are deliberately limited to things a public website does anyway. For anything sensitive, call the API from your own server (Node, PHP, …) and keep the key in an environment variable.

### Scopes (permissions)

| Scope | Allows |
|---|---|
| `store:read` | `GET /store`, `GET /categories` |
| `products:read` | `GET /products`, `GET /products/{id}` |
| `orders:create` | `POST /orders` |
| `orders:track` | `GET /orders/{order_no}?phone=…` |
| `customers:create` | `POST /customers` |

Give a key only the scopes it needs. A request without the right scope returns `403 insufficient_scope`.

---

## 2. Conventions

**Success** responses are `{ "data": … }`, with `"meta"` for paginated lists. **Errors** are always:

```json
{ "error": { "code": "invalid_api_key", "message": "That API key is not valid." } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `bad_request`, `invalid_phone`, … | Something in your request is wrong; `message` says what. |
| 401 | `missing_api_key`, `invalid_api_key`, `expired_api_key` | Key missing, wrong, revoked or expired. |
| 403 | `insufficient_scope`, `origin_not_allowed`, `module_disabled`, `business_inactive` | The key is not allowed to do this. |
| 404 | `not_found` | Unknown product, order or endpoint. |
| 409 | `bad_request` | Conflict, e.g. an item is out of stock. |
| 429 | `rate_limited` | Too many requests. Wait for `Retry-After` seconds. |
| 503 | `api_disabled`, `maintenance` | The API is switched off or the platform is under maintenance. |

**Rate limits.** Each key has a per-minute limit (default 120). Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (Unix seconds).

**CORS.** Browsers may call the API from any origin that the key allows. If the key lists allowed websites, requests from other origins get `403 origin_not_allowed`.

**Money** is a plain number in the business currency (`currency` is returned on products and orders). **Timestamps** are ISO-8601 UTC.

**Health check (no key needed):** `GET /ping` → `{ "data": { "ok": true, "version": "v1", "time": "…" } }`.

---

## 3. Endpoints

### `GET /store` — scope `store:read`
The business profile for headers/footers/contact pages.

```json
{ "data": { "name": "ZanLux Scents", "short_name": "ZanLux", "slug": "zanlux", "tagline": "The Essence Of Elegance",
  "currency": "TZS", "timezone": "Africa/Dar_es_Salaam", "theme": { "primary": "#d4af55", "accent": "#f1d98a" },
  "settings": { "phone": "+255 …", "whatsapp": "255…", "email": "…", "address": "…", "hours": "…" } } }
```

### `GET /categories` — scope `store:read`
Categories that contain at least one published product: `[{ "id": 3, "name": "Oud", "product_count": 12 }]`.

### `GET /products` — scope `products:read`
Published, active products only. Query parameters (all optional):

| Param | Description |
|---|---|
| `category` | Category id |
| `q` | Search in name, brand and description |
| `featured` | `true` for featured items |
| `in_stock` | `true` to hide out-of-stock |
| `min_price`, `max_price` | Price range |
| `sort` | `price_asc`, `price_desc`, `newest`, `name` (default: featured first) |
| `updated_since` | ISO date/time; only products changed since then (for syncing) |
| `page`, `limit` | Pagination (`limit` max 100, default 24) |

```json
{ "data": [ { "id": 12, "sku": "ZL-0012", "name": "Royal Oud 50ml", "brand": "ZanLux", "size": "50ml",
    "description": "…", "price": 85000, "currency": "TZS", "image_url": "https://…",
    "category": { "id": 3, "name": "Oud" }, "featured": true,
    "availability": "in_stock", "max_order_qty": 20 } ],
  "meta": { "total": 41, "page": 1, "limit": 24, "pages": 2 } }
```

`availability` is `in_stock`, `low_stock` or `out_of_stock`. Cost prices and exact stock counts are never exposed.

### `GET /products/{id}` — scope `products:read`
One product (same shape), or `404 not_found`.

### `POST /orders` — scope `orders:create`
Places a customer order. The business is notified instantly and the order appears in its dashboard.

```json
{
  "customer_name": "Asha Hamisi",
  "customer_phone": "0755 123 456",
  "customer_email": "asha@example.com",
  "delivery_method": "delivery",
  "address": "Mipango, Dodoma",
  "notes": "Please call before arriving",
  "items": [ { "product_id": 12, "qty": 1 }, { "product_id": 15, "qty": 2 } ]
}
```

`customer_name`, `customer_phone` and `items` are required. `delivery_method` is `pickup` (default) or `delivery` (then `address` is required). Up to 30 lines, 20 units per line. Prices are taken from the server; you cannot set them.

**Response `201`:**

```json
{ "data": { "order_no": "ZL-W00042", "total": 135000, "status": "new", "currency": "TZS",
            "message": "We will contact you shortly." } }
```

**Idempotency.** Send an `Idempotency-Key` header (any unique string up to 80 characters, e.g. a UUID generated when the customer opens checkout). If the request is retried — slow network, double click — you get the *original* response again (header `Idempotent-Replayed: true`) instead of a duplicate order. **Always send one.**

### `GET /orders/{order_no}?phone=…` — scope `orders:track`
Lets a customer check status. The order number **and** the phone used on the order must match, otherwise `404`.

```json
{ "data": { "order_no": "ZL-W00042", "status": "confirmed", "total": 135000, "currency": "TZS",
  "created_at": "2026-11-02T08:14:03.000Z", "delivery_method": "delivery",
  "items": [ { "name": "Royal Oud 50ml", "qty": 1, "unit_price": 85000, "line_total": 85000 } ] } }
```

`status` is one of `new`, `contacted`, `confirmed`, `completed`, `cancelled`.

### `POST /customers` — scope `customers:create`
Registers a customer (newsletter, loyalty sign-up). Requires the business to have the Customers module on.

```json
{ "name": "Joe Mushi", "phone": "0766 000 999", "email": "joe@example.com", "birthday": "1992-05-14", "marketing_ok": true }
```

Returns `201 { "data": { "status": "created" } }` or `200 { "data": { "status": "already_registered" } }`.

---

## 4. Examples

### Browser (vanilla JavaScript)

```html
<script>
const API = 'https://backend.fourbrothers.online/api/v1';
const KEY = 'fbk_live_xxxxxxxx';           // restricted to this website's origin

async function api(path, options = {}) {
  const res = await fetch(API + path, { ...options, headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error.message);     // { error: { code, message } }
  return body;
}

// Show products
api('/products?limit=12&sort=newest').then(({ data }) => {
  document.querySelector('#grid').innerHTML = data.map(p =>
    `<article><img src="${p.image_url || ''}" alt=""><h3></h3><b>${p.currency} ${p.price.toLocaleString()}</b></article>`).join('');
  // Use textContent for names/descriptions to avoid injecting HTML:
  document.querySelectorAll('#grid h3').forEach((h, i) => h.textContent = data[i].name);
});

// Place an order (one Idempotency-Key per checkout attempt)
const checkoutId = crypto.randomUUID();
api('/orders', { method: 'POST', headers: { 'Idempotency-Key': checkoutId },
  body: JSON.stringify({ customer_name: 'Asha', customer_phone: '0755123456', items: [{ product_id: 12, qty: 1 }] }) })
  .then(({ data }) => alert('Order ' + data.order_no + ' received!'))
  .catch(e => alert(e.message));
</script>
```

### Node.js (server side)

```js
// Node 18+, key kept in an environment variable
const API = 'https://backend.fourbrothers.online/api/v1';
const headers = { 'X-API-Key': process.env.FBBMS_KEY, 'Content-Type': 'application/json' };

const products = await (await fetch(`${API}/products?in_stock=true`, { headers })).json();

const res = await fetch(`${API}/orders`, {
  method: 'POST',
  headers: { ...headers, 'Idempotency-Key': 'cart-8f2c1' },
  body: JSON.stringify({ customer_name: 'Asha', customer_phone: '0755123456', items: [{ product_id: 12, qty: 2 }] })
});
console.log(res.status, await res.json());
```

### PHP

```php
<?php
$api = 'https://backend.fourbrothers.online/api/v1';
$key = getenv('FBBMS_KEY');

function fbbms($method, $path, $body = null, $extra = []) {
  global $api, $key;
  $ch = curl_init($api . $path);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_HTTPHEADER => array_merge(['X-API-Key: ' . $key, 'Content-Type: application/json'], $extra),
    CURLOPT_POSTFIELDS => $body ? json_encode($body) : null,
  ]);
  $out = json_decode(curl_exec($ch), true); curl_close($ch); return $out;
}

$products = fbbms('GET', '/products?limit=12');
$order = fbbms('POST', '/orders',
  ['customer_name' => 'Asha', 'customer_phone' => '0755123456', 'items' => [['product_id' => 12, 'qty' => 1]]],
  ['Idempotency-Key: ' . uniqid('cart_', true)]);
```

### curl

```bash
curl -H "X-API-Key: $FBBMS_KEY" "https://backend.fourbrothers.online/api/v1/products?limit=3"
curl -X POST -H "X-API-Key: $FBBMS_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: demo-1" \
  -d '{"customer_name":"Asha","customer_phone":"0755123456","items":[{"product_id":12,"qty":1}]}' \
  https://backend.fourbrothers.online/api/v1/orders
```

---

## 5. Webhooks (real-time events)

Instead of polling, give FBBMS a URL and it will `POST` events to it. Create webhooks in **API & webhooks → Webhooks** (the signing secret `whsec_…` is shown once).

| Event | When |
|---|---|
| `order.created` | A new order was placed (site, API or app) |
| `order.updated` | The business changed an order's status |
| `sale.completed` | A sale was rung up at the till |
| `stock.low` | A product fell to or below its low-stock level |

Your URL must be public `https://` (private/local addresses are refused). Respond with any `2xx` within 8 seconds. Failed deliveries are retried (after about 5 s and 30 s); a webhook that keeps failing is disabled automatically and flagged in the dashboard.

**Request**

```
POST /your-endpoint
Content-Type: application/json
X-FBBMS-Event: order.created
X-FBBMS-Timestamp: 1793605243
X-FBBMS-Signature: sha256=3b1f…

{ "id": "evt_9f3a1c0d2b7e4a55", "event": "order.created", "created": "2026-11-02T08:14:03.120Z",
  "data": { "order_no": "ZL-W00042", "total": 135000, "currency": "TZS",
            "customer": { "name": "Asha Hamisi", "phone": "255755123456", "email": null },
            "delivery_method": "delivery", "items": [ { "product_id": 12, "name": "Royal Oud 50ml", "qty": 1, "unit_price": 85000 } ] } }
```

### Verify the signature (always do this)

The signature is `HMAC-SHA256(secret, timestamp + "." + rawBody)` in hex, prefixed with `sha256=`. Use the **raw** request body (not re-serialised JSON) and reject old timestamps (e.g. older than 5 minutes) to stop replay.

**Node.js (Express)**

```js
const crypto = require('crypto');
app.post('/fbbms-hook', express.raw({ type: 'application/json' }), (req, res) => {
  const ts = req.header('X-FBBMS-Timestamp'), sig = req.header('X-FBBMS-Signature');
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.FBBMS_WEBHOOK_SECRET).update(ts + '.' + req.body.toString('utf8')).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  if (!fresh || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(400);
  const event = JSON.parse(req.body);
  // handle event.event / event.data — use event.id to ignore duplicates
  res.sendStatus(200);
});
```

**PHP**

```php
$raw = file_get_contents('php://input');
$ts  = $_SERVER['HTTP_X_FBBMS_TIMESTAMP'] ?? '';
$sig = $_SERVER['HTTP_X_FBBMS_SIGNATURE'] ?? '';
$expected = 'sha256=' . hash_hmac('sha256', $ts . '.' . $raw, getenv('FBBMS_WEBHOOK_SECRET'));
if (abs(time() - (int)$ts) > 300 || !hash_equals($expected, $sig)) { http_response_code(400); exit; }
$event = json_decode($raw, true);
http_response_code(200);
```

Because deliveries can be retried, handle each `event.id` **at most once**.

---

## 6. Going live checklist

- Create a separate key per website/app, with the **fewest scopes** and the exact **allowed websites**.
- Always send `Idempotency-Key` on `POST /orders`.
- Cache `GET /products` for 30–60 seconds on your side, or sync with `updated_since`, instead of calling on every page view.
- Verify webhook signatures and the timestamp.
- Keep keys out of public repositories. If one leaks, **revoke it** in the dashboard and create a new one; revoked keys stop working immediately.
- Watch the per-key request log in **API & webhooks** (and the platform monitor for the Developer) for errors and unusual traffic.

## 7. Legacy endpoint

`/api/public/{slug}/…` (used by the original ZanLux website) keeps working unchanged and needs no key. New integrations should use `/api/v1`, which adds keys, scopes, rate limits, idempotency and webhooks.
