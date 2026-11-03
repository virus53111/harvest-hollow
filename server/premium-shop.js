// Optional, server-verified cosmetic shop for the public multi-farm host.
//
// The base game is MIT licensed. This shop is a separate extension: no secret or
// price is ever trusted from the browser. Items are cosmetic overlays only.
// Requires a persistent HH_DATA_DIR volume before use with real money.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

export const SHOP_ITEMS = Object.freeze({
  golden_frame: Object.freeze({ id: 'golden_frame', name: 'Золотая рамка фермера', description: 'Золотое оформление интерфейса фермы', amount: 299, icon: '✨' }),
  fireflies: Object.freeze({ id: 'fireflies', name: 'Волшебные светлячки', description: 'Живые огоньки вокруг игрового интерфейса', amount: 499, icon: '🦋' }),
  farmer_crown: Object.freeze({ id: 'farmer_crown', name: 'Корона фермера', description: 'Эксклюзивная корона и значок над интерфейсом', amount: 699, icon: '👑' }),
});

const now = () => Date.now();
const filled = (s) => typeof s === 'string' && s.trim().length > 0;
const keyRegex = /^sk_(test|live)_[a-zA-Z0-9]+$/;

function loadStore(location) {
  fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
  try {
    const data = JSON.parse(fs.readFileSync(location, 'utf8'));
    if (data && typeof data === 'object' && data.pending && data.purchases && data.events) return data;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { pending: {}, purchases: {}, events: {} };
}

function persistStore(location, data) {
  const tmp = location + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, location);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function verifySignature(raw, header, secret) {
  if (!Buffer.isBuffer(raw) || !filled(header) || !filled(secret)) return false;
  const parts = Object.fromEntries(header.split(',').map(item => {
    const n = item.indexOf('=');
    return [item.slice(0, n), item.slice(n + 1)];
  }));
  const t = Number(parts.t);
  if (!Number.isSafeInteger(t) || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const signature = crypto.createHmac('sha256', secret).update(String(t) + '.').update(raw).digest('hex');
  const a = Buffer.from(signature, 'hex');
  for (const match of header.split(',').filter(p => p.startsWith('v1='))) {
    const b = Buffer.from(match.slice(3), 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function safeBaseUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === 'localhost')) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function purchasedItems(db, farmId, pid) {
  return [...new Set(Object.values(db.purchases)
    .filter(p => p.farmId === farmId && p.pid === pid && p.status === 'paid')
    .map(p => p.sku))];
}

async function checkoutSession(secret, data) {
  const result = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + secret,
      'content-type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': data.requestId,
    },
    body: new URLSearchParams({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'eur',
      'line_items[0][price_data][unit_amount]': String(data.item.amount),
      'line_items[0][price_data][product_data][name]': data.item.name,
      'line_items[0][quantity]': '1',
      'metadata[farm_id]': data.farmId,
      'metadata[pid]': data.pid,
      'metadata[sku]': data.item.id,
      client_reference_id: data.requestId,
      success_url: data.baseUrl + '/f/' + data.farmId + '?shop=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: data.baseUrl + '/f/' + data.farmId + '?shop=cancel',
    }).toString(),
    signal: AbortSignal.timeout(12000),
  });
  if (!result.ok) throw new Error('Stripe Checkout session could not be created (' + result.status + ')');
  const body = await result.json();
  if (typeof body.id !== 'string' || !body.id.startsWith('cs_') || !filled(body.url)) {
    throw new Error('Stripe response did not include a Checkout Session URL');
  }
  const parsed = new URL(body.url);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.stripe.com')) {
    throw new Error('Stripe returned an invalid checkout URL');
  }
  return { id: body.id, url: body.url };
}

/**
 * Mounts the integration in multi.js.
 * Store: HH_DATA_DIR/shop/purchases.json on the SAME durable volume as farms.
 * Auth: exactly the same member token as the game's existing invite/status API.
 */
export function createPremiumShop({ cfg, reg, sameOrigin, keyOf, log = console }) {
  const secret = process.env.STRIPE_SECRET_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const baseUrl = safeBaseUrl(process.env.PUBLIC_BASE_URL || '');
  const isTest = secret.startsWith('sk_test_');
  const isLive = secret.startsWith('sk_live_');
  const configured = keyRegex.test(secret) && filled(webhookSecret) && Boolean(baseUrl)
    && process.env.SHOP_ENABLE_PAYMENTS === '1' && (isTest || (isLive && process.env.SHOP_ALLOW_LIVE === '1'));
  const dataPath = path.join(cfg.dataDir, 'shop', 'purchases.json');
  const db = loadStore(dataPath);
  const throttle = new Map();
  // The original game's 7-day farm expiry must not erase paid purchases.
  // This hook is based only on server-verified, non-refunded transactions.
  reg.premiumRetain = (farmId) => Object.values(db.purchases).some(p => p.farmId === farmId && p.status === 'paid');

  function save() { persistStore(dataPath, db); }
  async function member(req) {
    const key = keyOf(req);
    if (!key) return null;
    const rec = await reg.acquire(req.params.id);
    if (!rec || !rec.host) return null;
    const grant = await rec.host.call('grantOf', key);
    return grant && grant.kind === 'member' ? { farmId: req.params.id, pid: grant.pid } : null;
  }
  const catalog = Object.values(SHOP_ITEMS).map(item => ({
    id: item.id, name: item.name, description: item.description,
    amount: item.amount, currency: 'eur', icon: item.icon,
  }));

  function mountGlobal(app) {
    app.get('/api/shop/catalog', (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ items: catalog, enabled: configured, mode: configured ? (isLive ? 'live' : 'test') : 'preview' });
    });

    // Register BEFORE express.json: Stripe signs the exact raw bytes.
    app.post('/api/shop/webhook', express.raw({ type: 'application/json', limit: '256kb' }), (req, res) => {
      if (!configured) return res.status(503).json({ error: 'NOT_CONFIGURED' });
      if (!verifySignature(req.body, req.headers['stripe-signature'], webhookSecret)) {
        return res.status(400).json({ error: 'INVALID_SIGNATURE' });
      }
      let event;
      try { event = JSON.parse(req.body.toString('utf8')); }
      catch { return res.status(400).json({ error: 'INVALID_EVENT' }); }
      if (!event || typeof event.id !== 'string' || !event.data?.object) return res.status(400).json({ error: 'INVALID_EVENT' });
      if (db.events[event.id]) return res.json({ received: true });
      const session = event.data.object;
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const pending = db.pending[session.id];
        // Only credit a Checkout Session created by this server; never credit redirect params.
        if (pending && session.payment_status === 'paid' && session.amount_total === pending.amount
          && session.currency === 'eur' && session.metadata?.sku === pending.sku
          && session.metadata?.pid === pending.pid && session.metadata?.farm_id === pending.farmId) {
          db.purchases[session.id] = {
            ...pending, paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
            status: 'paid', purchasedAt: now(),
          };
          delete db.pending[session.id];
        }
      } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
        const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : null;
        for (const purchase of Object.values(db.purchases)) {
          if (paymentIntent && purchase.paymentIntent === paymentIntent) purchase.status = 'refunded';
        }
      }
      db.events[event.id] = now();
      try { save(); }
      catch (e) {
        log.error('premium shop could not persist webhook result', e);
        return res.status(500).json({ error: 'PERSIST_FAILED' });
      }
      return res.json({ received: true });
    });
  }

  function mountFarm(farmApi) {
    farmApi.get('/shop/entitlements', async (req, res) => {
      try {
        const m = await member(req);
        if (!m) return res.status(401).json({ error: 'AUTH' });
        return res.json({ items: purchasedItems(db, m.farmId, m.pid) });
      } catch {
        return res.status(503).json({ error: 'UNAVAILABLE' });
      }
    });
    farmApi.post('/shop/checkout', sameOrigin, express.json({ limit: '2kb' }), async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!configured) return res.status(503).json({ error: 'SHOP_NOT_CONFIGURED' });
      const item = SHOP_ITEMS[req.body?.sku];
      if (!item) return res.status(400).json({ error: 'UNKNOWN_ITEM' });
      let m;
      try { m = await member(req); }
      catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
      if (!m) return res.status(401).json({ error: 'AUTH' });
      if (purchasedItems(db, m.farmId, m.pid).includes(item.id)) return res.status(409).json({ error: 'ALREADY_OWNED' });
      const rateKey = m.farmId + ':' + m.pid;
      const last = throttle.get(rateKey) || 0;
      if (now() - last < 6500) return res.status(429).json({ error: 'RATE' });
      throttle.set(rateKey, now());
      if (throttle.size > 3000) for (const [k, v] of throttle) if (now() - v > 60000) throttle.delete(k);
      try {
        const session = await checkoutSession(secret, {
          item, farmId: m.farmId, pid: m.pid, baseUrl,
          requestId: crypto.randomUUID(),
        });
        db.pending[session.id] = { farmId: m.farmId, pid: m.pid, sku: item.id, amount: item.amount, createdAt: now() };
        save();
        return res.json({ url: session.url });
      } catch (err) {
        log.error('premium Checkout creation failed', err);
        return res.status(502).json({ error: 'CHECKOUT_FAILED' });
      }
    });
  }

  return { mountGlobal, mountFarm };
}
