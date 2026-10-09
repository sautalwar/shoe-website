# ShoeShop

A beginner-friendly shoe-store **demo**, built with Node.js 22, Express, EJS templates, and SQLite. Pages are rendered on the server; you do not need a separate frontend server.

**No payment is taken and no real order is placed.** Do not enter real customer or payment information. This is not a production shop: there are no customer accounts, payment integrations, inventory reservations, shipping, taxes, or fulfillment.

## Project status

**Local acceptance: APPROVE.** Independent verification completed a clean `npm ci`, all **38 tests**, and actual Chromium desktop/keyboard/mobile checks through catalog → product → cart → checkout → confirmation. Search/filter/empty states, restart, database reset, and idle session expiry passed. Layouts had no horizontal overflow at 320, 375, and 1440 pixels; all 12 local SVG illustrations loaded without external requests or browser errors. Listener smoke checks and clean shutdown also passed. No hosted deployment is claimed.

**Source published:** [sautalwar/shoe-website](https://github.com/sautalwar/shoe-website) is a verified public GitHub repository on `main`. Source publication is complete; it does not itself deploy the website.

**Live hosting: not deployed; blocked pending Render authorization.** No authorized Render account/API/CLI access is available. The free-only Blueprint is published and ready for the owner to authorize setup through the [Render deployment link](https://render.com/deploy?repo=https://github.com/sautalwar/shoe-website). This is a provider setup link, not a live storefront.

## What you can try

- Browse sample shoes with original, local SVG illustrations—not retailer photographs.
- Search names and descriptions; combine category and US-size filters; sort by featured order, price, or name.
- Choose an available **US size** and a quantity, then add, update, or remove cart items.
- Review server-calculated USD prices and the cart subtotal.
- Explicitly acknowledge simulated checkout, then view a session-only demo confirmation.
- Use responsive pages on desktop or mobile, with labeled forms and keyboard navigation. Core flows do not require browser JavaScript.

Sizes use the displayed US system; no gender-specific conversion is implied. Quantities are 1–10 per product/size line, with at most 20 distinct lines and 100 total units. Cart prices come from the catalog, not browser-submitted totals.

## Run locally in PowerShell

### 1. Check prerequisites

Install **Node.js 22.19.x**, which includes npm. The project pins Node 22.19.0 in `.node-version` and declares `22.19.x` in `package.json`.

From this project's directory:

```powershell
node --version
npm --version
npm ci
```

`npm ci` installs the exact dependencies recorded in `package-lock.json`. It may take a little longer the first time.

SQLite access uses `better-sqlite3`, a native Node module. Local native loading and real database queries have been verified on the installed Node 22.19.0 runtime. Installation must still succeed on your selected operating system and on a hosting provider's Linux runtime; the presence of Node alone does not verify the SQLite driver. If installation reports a native-module error, first check the pinned Node version and the installation error. A platform without a compatible prebuilt binary may require native build prerequisites. Do not assume those tools are already installed, or change the database package just to hide the failure.

### 2. Configure this PowerShell session

Generate the required secret directly into an environment variable. This command does **not** print the secret:

```powershell
$env:SESSION_SECRET = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
$env:PORT = '3000'
$env:DB_PATH = '.data\shoeshop.sqlite'
$env:NODE_ENV = 'development'
$env:TRUST_PROXY = '0'
```

Keep the secret private: do not print it, paste it into chat, include it in logs/screenshots, or commit it. Startup requires at least 32 characters; use a random value, not a memorable password.

These variables apply only to this PowerShell process and programs started from it. Repeat configuration in a new terminal. Alternatively, copy `.env.example` to `.env` and supply your own local values; startup loads `.env`. Existing process environment variables take precedence. `.env` must remain untracked.

### 3. Start and open the store

```powershell
npm start
```

Keep that terminal open. Visit <http://localhost:3000/products>. Stop the server with **Ctrl+C** before maintenance.

For automatic server restarts while editing:

```powershell
npm run dev
```

Run only one server on the configured port. Watch-mode restarts also reset carts and confirmations.

In a second PowerShell terminal, check readiness:

```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/health'
```

A ready database returns HTTP 200 with `status: ok`. HTTP 503 means the catalog is unavailable; do not treat a listening process alone as a working storefront.

## Configuration reference

| Variable | Local value/default | Meaning |
| --- | --- | --- |
| `SESSION_SECRET` | Required; no default | Random private session-signing secret, at least 32 characters. |
| `PORT` | `3000` | Integer from 1–65535. Hosting should use the provider-supplied value. |
| `DB_PATH` | `.data\shoeshop.sqlite` | SQLite file in a writable directory, resolved relative to the working directory. |
| `NODE_ENV` | `development` locally | Set `production` for HTTPS hosting; production cookies are Secure. |
| `TRUST_PROXY` | `0` | `1` only for a verified trusted single-hop HTTPS reverse proxy; not unrestricted proxy trust. |

Use `NODE_ENV=development` for ordinary local HTTP. A production Secure cookie cannot be used over plain HTTP, so cart/session behavior will not work correctly if you enable production mode on localhost without HTTPS.

## Sample data, sessions, and resets

The SQLite database contains only sample products and their available sizes—no customer or order tables. Startup creates a missing database and seeds the catalog. Repeated startup does not duplicate products or overwrite existing valid rows. An unreadable or corrupt database is an error; it is not silently deleted.

Carts and the latest simulated confirmation live in a bounded, in-memory session store, **not SQLite**. They expire after 30 minutes of inactivity and disappear on application restart, watch-mode restart, or redeployment. Closing a tab is not a reliable session reset. Checkout reviews expire after 10 minutes and cannot be reused; changing the cart requires a fresh review.

If your old session expired or the store restarted, the site explains the reset. Refresh stale forms, choose products again, and review a new cart. A stale checkout submission must not produce a confirmation. A confirmation is not durable order history and cannot be looked up publicly.

### Reset the sample catalog

This is destructive, developer-only maintenance of the configured **demo** database:

1. Stop the app with **Ctrl+C**.
2. Check that `DB_PATH` points only to the disposable ShoeShop demo database. Never point it at another application's database.
3. With the local environment configured as above, explicitly acknowledge both the destructive demo reset and that the app is stopped:

   ```powershell
   npm run db:reset -- --confirm-demo-reset --app-stopped
   ```

   The script loads `.env` and requires valid configuration, including `SESSION_SECRET`. It resets only the configured demo SQLite file and its SQLite sidecars. Both flags are required; bare `npm run db:reset` is not sufficient. A live database owner's lock prevents reset; do not bypass it by deleting lock files.
4. Restart with `npm start`, then check `/health` and the sample catalog.

Resetting the catalog does not recover carts or confirmations. There is no website reset endpoint. Do not delete a corrupt database automatically as a troubleshooting shortcut.

## Tests and a manual demo check

```powershell
npm test
```

Tests use Node's built-in runner and Supertest, with isolated test databases/session stores. They cover catalog filtering/seeding, cart validation and repricing, simulated checkout, CSRF/session handling, startup/readiness, and concurrent session mutations. The integrated `npm test` run passed **38 of 38 tests**, after correcting session-store test fixtures to use JSON serialization. Independent verification reproduced the result after a clean `npm ci` and completed actual desktop/keyboard/mobile Chromium smoke checks, resulting in **APPROVE** for local acceptance. Tests and local browser checks do not verify a deployed service or constitute a comprehensive accessibility audit.

Before sharing the demo, check:

1. `/health` responds successfully, and product illustrations load.
2. Search and combine category/size filters; try a search with no results.
3. Open a product, pick an available US size, add it, then update and remove cart lines.
4. Review a nonempty cart, acknowledge the simulation, and select **“Simulate checkout — no payment.”**
5. Confirm the no-payment/no-real-order message and that the cart is empty.
6. Restart the server; verify the old cart/confirmation is gone and the sample catalog is present.
7. Try a narrow mobile viewport and keyboard-only navigation; inspect focus, labels, errors, and demo/storage notices.

## Hosting candidate: a free Render web service

Render is a **candidate**, not an already-deployed service or a guarantee of free availability. Check current [free-service eligibility and limits](https://render.com/docs/free) before deployment. Provider signup/sign-in and repository access require the owner's authorization; never share credentials in chat.

The published `render.yaml` Blueprint declares a single Free Node web service, generates a private session secret, and sets the configuration below. It has been validated against Render's Blueprint schema; schema validity is not deployment success. It declares no paid disk, separate database, custom scaling, or fixed `PORT`. To authorize Render and begin free-only setup:

[Deploy the ShoeShop Blueprint to Render](https://render.com/deploy?repo=https://github.com/sautalwar/shoe-website)

This link opens provider setup for the published repository; it is **not a live storefront URL** and does not mean deployment has occurred. Authorize Render access, inspect the Blueprint, and confirm Free compute before approving it. Provider setup remains an owner action. Do not add a payment method or approve purchases/paid resources.

For an authorized deployment:

| Setting | Value |
| --- | --- |
| Service | Node web service; explicitly choose eligible **Free** compute |
| Runtime | Node 22.19.x; verify native SQLite installation on Linux |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health path | `/health` |
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | Generated privately by the Blueprint (`generateValue: true`); never committed |
| `DB_PATH` | `.data/shoeshop.sqlite` within the application's writable runtime filesystem |
| `TRUST_PROXY` | `1` only after verifying the provider's single-hop HTTPS proxy arrangement |
| `PORT` | Use Render's supplied environment variable; do not hardcode the hosting port |

The server binds to `0.0.0.0`. Database creation and sample seeding happen at startup, **not during the build**: build-time files are not a substitute for runtime initialization.

Use one application process/instance. **No payment method, purchases, paid storage, or paid services are approved.** Do not add any of them, or a keep-alive monitor to work around free-service limits. Render documents possible overage billing when an account has a payment method; a Free compute selection is not a blanket guarantee against account-level charges. Free quotas can suspend the service. If deployment asks for a payment method or authorized free hosting is unavailable, stop and mark live hosting blocked rather than accepting charges.

Free services can spin down, cold-start slowly, reach quotas, or be suspended. The filesystem is [ephemeral](https://render.com/docs/deploys#ephemeral-filesystem): SQLite/local files may be lost on restart, redeploy, or spin-down. Startup restores **sample products only**, never old carts or confirmations. Even if a local SQLite file survives a normal local restart, memory sessions do not. This design is unsuitable for real orders or multi-instance production use.

After deployment, independently verify HTTPS, `/health`, catalog images/filtering, cart and checkout, Secure cookies, and restart/reseed behavior before recording any actual live URL.

**GitHub Pages cannot host this application**: it serves static files, not the Express process, SQLite, or server-side sessions. Publishing source on GitHub does not deploy the backend.

## Privacy and safety

- Never collect names, emails, addresses, phone numbers, card details, or other customer information.
- Use only sample products; do not claim real stock, shipping availability, or successful payment.
- No tracking services, external commerce APIs, or payment provider are needed.
- State-changing forms require session-bound CSRF tokens. Refresh after session expiry rather than bypassing validation.
- Keep `.env`, database files/sidecars, dependency folders, and local logs out of source publication.
- Keep unexpected errors generic to visitors; never log secrets, cookies, session/review tokens, or submitted bodies.
