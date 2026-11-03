# Harness Hollow — optional Stripe cosmetics shop

> **Status: implementation branch, NOT live.** No payments are possible by default.
> The upstream Harness Hollow game is MIT licensed by Krasimir Kralev.
> The cosmetics extension must not be used with real money before production readiness review.

## What this adds

- Public marketing page: `/shop.html`, linked from the game's homepage.
- Game button `✦ VIP`, opening a small in-game cosmetic shop.
- One-time cosmetic items with prices set on the **server**, not in the browser:
  - `golden_frame` — €2.99: gold decoration around the level card.
  - `fireflies` — €4.99: animated UI sparkles.
  - `farmer_crown` — €6.99: premium title and crown in the HUD.
- Stripe-hosted Checkout: `POST /api/f/:id/shop/checkout`.
- Signed Stripe webhook: `POST /api/shop/webhook`.
- Server-authoritative inventory: `GET /api/f/:id/shop/entitlements`.
- Webhook idempotency, paid amount/currency verification, server-issued session binding,
  and revocation on refund or dispute.
- Data stored at `<HH_DATA_DIR>/shop/purchases.json` using atomic writes.
- Farms with active paid purchases are **not automatically deleted for inactivity**;
  players can still delete their own farms.

These items are *cosmetic UI effects*, **not** 3D hats, pets, farm buildings, additional currency, or gameplay buffs. Do not market them as those things.

## Set up hosting (Render, production architecture)

This repo contains a Node 24 Dockerfile and a public multi-farm server. See [deploy/cloud.md](deploy/cloud.md).

1. Deploy this branch using the Render **Docker Web Service** runtime.
2. Keep **one instance** (`HH_MODE=multi`, `HH_DATA_DIR=/data`).
3. Choose a **paid** web-service instance and attach a **persistent disk at `/data` (1GB+)**.
   Without it, farms and customer purchases are lost on restart. Do not activate checkout on
   Render Free (ephemeral filesystem) or without backups. A healthy website alone is not enough.
4. Configure `PUBLIC_BASE_URL=https://your-actual-host.example`; use the site's actual https origin.
5. Keep `HH_HELPER=off` until the separate AI helper credentials and acceptable-use requirements are configured.
6. Set `HH_STARS_URL=off` if you do not want to show the original project's stars.
7. Test public game creation, invite, return visit, Stripe webhooks, persistence across deployment,
   refunds, and mobile rendering before moving beyond test mode.

## Stripe Checkout (TEST MODE first)

Connect your **own** Stripe account and set secrets in **Render environment variables**, never source code or chat:

| Variable | Test value | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` | Secret server API key |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Signing secret for this exact webhook endpoint |
| `PUBLIC_BASE_URL` | `https://your-site.onrender.com` | Trusted return URLs |
| `SHOP_ENABLE_PAYMENTS` | `1` | Enables only when all above are set |
| `SHOP_ALLOW_LIVE` | unset | Safety gate: live charges disabled |

Add Stripe webhook endpoint `https://your-site.onrender.com/api/shop/webhook` and subscribe to:
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `charge.refunded`
- `charge.dispute.created`

After the buyer pays, the client does not trust `?shop=success` or the Checkout redirect.
It retrieves items from the authenticated farm route, which consults signed webhook results
stored on the server. A fake redirect grants **nothing**.

To test locally, use a persistent temporary `HH_DATA_DIR` and `npm test`. The
`test/premium-shop.test.js` test fakes Checkout API responses and signed Stripe webhook
events; it does **not** perform real charges.

## Before enabling LIVE charging

These are release blockers, not optional polish:

1. Connect and verify a **live** Stripe business account that belongs to the operator,
   plus verify that the business can legally sell digital goods where offered.
2. Provide legal seller identity, customer contact, updated privacy policy, purchase terms,
   and a clear refund/support procedure. The original upstream `/privacy` and landing
   copy describe *a different operator and a free game*; they MUST be adapted for this fork.
3. Configure applicable EU VAT/digital-services tax and country requirements (e.g. Stripe Tax
   or another compliant solution); the current checkout does not calculate tax.
4. Verify the right to commercially redistribute all third-party game assets and marks.
   The upstream README documents MIT source, CC0 models/audio and SIL OFL fonts.
5. Add a purchase recovery/account migration policy before selling permanent unlocks,
   because items currently belong to a specific farm and farmer; deleting that farm
   permanently disconnects the entitlements even though the purchase history remains.
6. Configure durable storage, backups and incident monitoring; ensure single-writer service.
7. Test real-world webhook retries, chargebacks/refunds, and return-to-game purchases.
8. Only **then** set `STRIPE_SECRET_KEY=sk_live_...`, the matching **live**
   `STRIPE_WEBHOOK_SECRET` and `SHOP_ALLOW_LIVE=1`. This extra gate prevents an
   accidental live charge while developing.

## Limitations / future work

- No registration or customer account linking yet: the purchase belongs to one farmer in
  one farm. There is no cross-farm item sharing or transfer.
- Only three cosmetic HUD effects are implemented. Real 3D furniture, hats and pets need
  separate game-asset, animation and persistence work.
- The shop is available only in multi-farm hosting mode.
- No payments are possible in the repo by default; environment secrets must be provisioned
  by the account owner. GitHub, ChatGPT and Render connectors do not automatically share a
  Stripe API key with the deployed server.
- Do not claim the live website is accepting payments until a test purchase and actual
  Stripe live-mode webhook have both been verified.

## Original project

[Harness Hollow](https://github.com/KrasimirKralev/harvest-hollow) by Krasimir Kralev,
licensed under the [MIT License](LICENSE). Retain existing third-party credits.
