// Regression test: a Stripe redirect alone never grants an item, while a signed
// paid webhook does. No real network requests or Stripe credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { createPremiumShop } from '../server/premium-shop.js';

test('Stripe cosmetics require server-created session and a valid paid webhook', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-premium-'));
  const originalFetch = globalThis.fetch;
  const before = Object.fromEntries(['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','PUBLIC_BASE_URL','SHOP_ENABLE_PAYMENTS'].map(k => [k,process.env[k]]));
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [k,v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.STRIPE_SECRET_KEY = 'sk_test_localtest';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_localtest';
  process.env.PUBLIC_BASE_URL = 'http://localhost';
  process.env.SHOP_ENABLE_PAYMENTS = '1';

  const reg = {
    acquire: async () => ({ host: {
      call: async (method, token) => method === 'grantOf' && token === 'valid-member-key'
        ? { kind: 'member', pid: 'p1' } : null,
    } }),
  };
  const app = express();
  const shop = createPremiumShop({
    cfg: { dataDir: dir },
    reg,
    sameOrigin: (_req,_res,next) => next(),
    keyOf: req => req.headers.authorization?.slice(7) || null,
  });
  shop.mountGlobal(app);
  const farmRouter = express.Router({ mergeParams: true });
  shop.mountFarm(farmRouter);
  app.use('/api/f/:id', farmRouter);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { authorization:'Bearer valid-member-key', 'content-type':'application/json' };

  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.stripe.com')) {
      assert.equal(options.method,'POST');
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('line_items[0][price_data][unit_amount]'),'299');
      assert.equal(body.get('metadata[sku]'),'golden_frame');
      assert.equal(body.get('metadata[pid]'),'p1');
      return Response.json({
        id:'cs_test_purchase123',
        url:'https://checkout.stripe.com/c/pay/cs_test_purchase123',
      });
    }
    return originalFetch(url,options);
  };

  const endpoint=base+'/api/f/ABCDEF123456/shop';
  const entitlement=async()=> (await (await fetch(endpoint+'/entitlements',{headers})).json()).items;
  assert.deepEqual(await entitlement(),[]);
  const checkout = await fetch(endpoint+'/checkout',{
    method:'POST',headers,body:JSON.stringify({sku:'golden_frame'}),
  });
  assert.equal(checkout.status,200);
  const redirect = await checkout.json();
  assert.ok(redirect.url.startsWith('https://checkout.stripe.com/'));
  // Even though a fake 'success' URL was produced, no item is granted.
  assert.deepEqual(await entitlement(),[]);

  const event={
    id:'evt_paid_123',type:'checkout.session.completed',
    data:{object:{
      id:'cs_test_purchase123',payment_status:'paid',amount_total:299,currency:'eur',
      payment_intent:'pi_example',metadata:{sku:'golden_frame',pid:'p1',farm_id:'ABCDEF123456'},
    }},
  };
  const payload=JSON.stringify(event);
  const signature=body=>{
    const timestamp=Math.floor(Date.now()/1000);
    const digest=crypto.createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(timestamp+'.'+body).digest('hex');
    return 't='+timestamp+',v1='+digest;
  };
  const send=async (body, valid=true)=>originalFetch(base+'/api/shop/webhook',{
    method:'POST',headers:{'content-type':'application/json','stripe-signature':signature(valid?body:'tampered')},
    body,
  });
  assert.equal((await send(payload,false)).status,400);
  assert.deepEqual(await entitlement(),[]);
  assert.equal((await send(payload)).status,200);
  assert.deepEqual(await entitlement(),['golden_frame']);
  assert.equal(reg.premiumRetain('ABCDEF123456'),true);
  assert.equal((await send(payload)).status,200); // Stripe webhook retries are idempotent.
  assert.deepEqual(await entitlement(),['golden_frame']);
  assert.equal((await fetch(endpoint+'/checkout',{method:'POST',headers,body:JSON.stringify({sku:'golden_frame'})})).status,409);

  const refund=JSON.stringify({
    id:'evt_refund_123',type:'charge.refunded',data:{object:{payment_intent:'pi_example'}},
  });
  assert.equal((await send(refund)).status,200);
  assert.deepEqual(await entitlement(),[]);
  assert.equal(reg.premiumRetain('ABCDEF123456'),false);
});
