// The multi-farm host (HH_MODE=multi; docs/agent-briefs/multi-farm.md, wire details docs/agent-notes/mf-server.md):
// one public URL, many private farms, each the same game a single-farm server runs (server/farms.js loads them on
// demand). Single mode (the default) never loads this file.
//
// Pages:  GET /                      public/landing.html (start a farm, this device's farms)
//         GET /privacy               public/privacy.html (what is kept and why, EN and BG; the privacy request form)
//         GET /f/:id[/]              the game page, exactly as a single-farm server serves / (holds no farm data)
//         GET /f/:id/manifest.webmanifest   the farm's home-screen manifest WITHOUT any key (start_url /f/<id>): what an
//                                    Android home-screen app needs (it shares the browser's storage). A device that keeps
//                                    a home-screen app's storage apart (iOS) gets a client-built one with the key in the
//                                    start URL's fragment instead (public/js/ui/farm-gate.js installFarmManifest)
//         GET /manifest[.bg].webmanifest   the landing's; every manifest here carries the landing's tagline, not the
//                                    home server's "shared over your home network" (QA r1 I-04)
// API:    GET  /api/status            global health: farm counts, no ids
//         GET  /api/stars             { stars: n | null }: the GitHub star count, fetched by this server (server/stars.js)
//         POST /api/farms             -> 201 { id, secret } | 429 { error: 'RATE', retryAfter } | 503 { error: 'FULL' }
//         GET  /api/f/:id/status      -> { ok, id, buildHash, ttlDays, slots, full, invite?, member?, pid?, waiting? } | 404
//                                     (waiting, members only: { [pid]: { at, exp, by } } seats whose new key is unused)
//         POST /api/f/:id/invite      Authorization: Bearer <secret> (or JSON { secret }) -> 201 { token, expiresAt }
//                                     | 401/403 { error: 'AUTH' } | 404 | 409 { error: 'FULL' } | 429 { error: 'RATE' }
//         POST /api/f/:id/rekey       Authorization: Bearer <member secret>, JSON { pid } (another farmer of the farm)
//                                     -> 201 { pid, token, expiresAt }: that farmer's old keys stop working, the token is
//                                     a one-time rejoin link /f/<id>?rejoin=<token> (7 days) | 401/403 { error: 'AUTH' }
//                                     (also a rejoin or invite token: they mint nothing) | 400 { error: 'BAD_REQUEST' }
//                                     | 404 | 429 { error: 'RATE' } (per address an hour, per farm a day)
//         POST /api/f/:id/delete      Authorization: Bearer <member secret> -> { ok }: the farm is deleted at once (its
//                                     folder, backups included); every open screen hears deny DELETED | 401/403 AUTH
//                                     | 404 | 429 { error: 'RATE' } (HH_DELETE_PER_HOUR per address)
//         /api/f/:id/dev/...          HH_DEV=1 + loopback only: warp, drop, save, unload; POST /api/dev/sweep
//         POST /api/ideas, /api/admin/ideas[/:id]   players' ideas and their admin list (server/ideas.js)
//         POST /api/privacy, /api/admin/privacy[/:id]   privacy requests from /privacy and their admin list (ideas.js)
// Socket: /ws?farm=<id>              unknown farm 404, too many sockets or handshakes from one address 429 (at the upgrade)
//
// Keys never travel in a URL the server sees except the single-use ?join= and ?rejoin= tokens (they are in the
// link anyway; the client wipes them from the address bar once used); the personal link's #k= is a fragment. No
// request logging; no key, hash or farm id in any log line, and no full client address (an abuse warning names the
// /24 or /48 network only: ip-limits.js maskIp).
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createLogger } from './log.js';
import { Perf } from './perf.js';
import { StaticFiles } from './static.js';
import { mountAssets, devRouter, isLoopback, WS_DEFLATE } from './http.js';
import { FarmRegistry, ID_RE, redactArg, redactLog } from './farms.js';
import { WindowLimiter, Counter, clientIp, maskIp } from './ip-limits.js';
import { multiConfig } from './config.js';
import { mountIdeas } from './ideas.js';
import { createPremiumShop } from './premium-shop.js';
import { StarCount } from './stars.js';
import { isTimeZone } from '../shared/rules/calendar.js';
import { LIMITS, PROTOCOL_VERSION } from '../shared/net/protocol.js';
import { CONTENT_HASH } from '../shared/content/index.js';
import { RULES_VERSION } from '../shared/rules/index.js';
import { PLAYER_SLOTS } from '../shared/content/config.js';
import FRONT_EN from '../public/js/i18n/en/front.js';
import FRONT_BG from '../public/js/i18n/bg/front.js';
import fs from 'node:fs';
import path from 'node:path';

const NO_STORE = 'no-store';
const KEY_RE = /^[A-Za-z0-9_-]{16,256}$/;

/** The player secret of a request: `Authorization: Bearer <key>`, else `X-HH-Key`, else JSON body `secret`. */
export function keyOf(req) {
  const auth = req.headers.authorization;
  const m = typeof auth === 'string' ? /^Bearer\s+(\S+)$/i.exec(auth) : null;
  const k = m ? m[1] : req.headers['x-hh-key'] || (req.body && typeof req.body === 'object' ? req.body.secret : undefined);
  return typeof k === 'string' && KEY_RE.test(k) ? k : null;
}

/** A state-changing request from a page of another site is refused (a browser sends Origin on every POST). */
function sameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: 'ORIGIN' });
  }
  return next();
}

/** A tiny fallback front door when public/landing.html is missing (the real one is the client's). */
const FALLBACK_LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Harness Hollow</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h1>Harness Hollow</h1><button id="go" type="button">Start a new farm</button><p id="st" role="status"></p>
<p>Farms nobody visits for 7 days are deleted.</p>
<script>document.getElementById('go').onclick=async()=>{const r=await fetch('/api/farms',{method:'POST'});
const b=await r.json().catch(()=>({}));if(r.ok){location.href='/f/'+b.id+'#k='+b.secret}else{
document.getElementById('st').textContent=r.status===429?'Too many new farms from here; try later.':'We are full right now.'}}</script>
</body></html>`;

/** /api/status of the host: health and counts, never an id. */
export function multiStatus(hh) {
  const f = hh.reg.summary();
  return {
    ok: !f.degraded && !f.saveError,
    mode: 'multi',
    degraded: f.degraded,
    version: hh.cfg.version,
    proto: PROTOCOL_VERSION,
    rules: RULES_VERSION,
    contentHash: CONTENT_HASH,
    buildHash: hh.static.build,
    serverNow: Date.now(),
    startedAt: hh.startedAt,
    uptimeS: Math.floor((Date.now() - hh.startedAt) / 1000),
    dev: hh.cfg.dev,
    ttlDays: hh.mc.ttlDays,
    farms: f,
    perf: hh.perf ? hh.perf.status(null) : null,
  };
}

/** The express app of the multi-farm host. */
export function createMultiApp(hh) {
  const { cfg, mc, reg, log } = hh;
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');                            // API answers are no-store; pages carry their own ETag
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // an invite link's ?join= must not leave in a Referer to another site
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  const ipOf = (req) => clientIp(req, mc.trustProxy);
  const create = new WindowLimiter([[60 * 60_000, mc.createPerHour], [24 * 60 * 60_000, mc.createPerDay]]);
  const invites = new WindowLimiter([[60 * 60_000, 30]]);
  const lookups = new WindowLimiter([[60_000, 120]]);     // /api/f/:id/* per address: no id scanning
  // new keys: per address (a guessed key is 256 bits, but nobody needs many) and per farm (two partners re-keying
  // each other all day is a quarrel, not a lost phone)
  const rekeys = new WindowLimiter([[60 * 60_000, mc.rekeyPerHour ?? 10]]);
  const rekeysFarm = new WindowLimiter([[24 * 60 * 60_000, mc.rekeyPerFarmDay ?? 10]]);
  const deletes = new WindowLimiter([[60 * 60_000, mc.deletePerHour ?? 10]]);
  hh.limiters = [create, invites, lookups, rekeys, rekeysFarm, deletes];
  hh.lookups = lookups;                                   // the socket handshake counts too (server: verifyClient)

  const game = (req, res, next) => {
    let page;
    try { page = hh.static.indexHtml(); } catch (err) { log.error('index.html could not be rendered', err); return next(); }
    if (!page) return next();
    res.setHeader('X-Robots-Tag', 'noindex');
    return hh.static.sendPage(req, res, page);
  };
  app.get('/', (req, res) => {
    let page = null;
    try { page = hh.static.indexHtml('landing.html'); } catch (err) { log.error('landing.html could not be rendered', err); }
    if (page) return hh.static.sendPage(req, res, page);
    res.setHeader('Cache-Control', 'no-cache');
    return res.type('html').send(FALLBACK_LANDING);
  });
  app.get('/index.html', (_req, res) => res.redirect(302, '/'));
  // the privacy note (public/privacy.html: English and Bulgarian, the privacy request form): multi mode only, since a
  // self-hosted server keeps its data itself (the repo's PRIVACY.md says so)
  app.get(['/privacy', '/privacy/'], (req, res, next) => {
    let page = null;
    try { page = hh.static.indexHtml('privacy.html'); } catch (err) { log.error('privacy.html could not be rendered', err); }
    return page ? hh.static.sendPage(req, res, page) : next();
  });
  app.get(['/f/:id', '/f/:id/'], (req, res, next) => (ID_RE.test(req.params.id) ? game(req, res, next) : res.status(404).type('text').send('Not found')));
  // any well-formed id gets one (no existence leak), and never a key: see the header
  // ?lang=bg: the Bulgarian description (public/manifest.bg.webmanifest), the device's language (ui/farm-gate.js)
  const baseManifests = new Map();
  /** A home-screen manifest of this host (parsed once), or null. Strangers play here over the internet: the files'
   *  "shared over your home network" (a home server's line) becomes the landing's tagline (QA r1 I-04). */
  const hostManifest = (file) => {
    let m = baseManifests.get(file);
    if (m) return m;
    try {
      m = JSON.parse(fs.readFileSync(path.join(cfg.root, 'public', file), 'utf8'));
    } catch (err) {
      log.error(`${file} could not be read`, redactArg(err));
      return null;
    }
    const tag = (file === 'manifest.bg.webmanifest' ? FRONT_BG : FRONT_EN)['front.hero.tag'];
    m = { ...m, ...(typeof tag === 'string' && tag ? { description: tag } : {}) };
    baseManifests.set(file, m);
    return m;
  };
  app.get('/f/:id/manifest.webmanifest', (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(404).type('text').send('Not found');
    const baseManifest = hostManifest(req.query.lang === 'bg' ? 'manifest.bg.webmanifest' : 'manifest.webmanifest');
    if (!baseManifest) return res.status(404).type('text').send('Not found');
    const at = `/f/${req.params.id}`;
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('X-Robots-Tag', 'noindex');
    return res.type('application/manifest+json').send(JSON.stringify({ ...baseManifest, id: at, start_url: at, scope: '/' }));
  });
  // the landing page's own (public/landing.html links /manifest.webmanifest): the same description, its own start
  app.get(['/manifest.webmanifest', '/manifest.bg.webmanifest'], (req, res, next) => {
    // express matches routes ignoring case: only the two names ever reach the disk
    const m = hostManifest(/bg/i.test(req.path) ? 'manifest.bg.webmanifest' : 'manifest.webmanifest');
    if (!m) return next();
    res.set('Cache-Control', 'no-cache');
    return res.type('application/manifest+json').send(JSON.stringify(m));
  });
  mountAssets(app, hh.static, cfg.root, { host: cfg.assets?.host !== false });   // /b/<build>/: this host serves option 2's files

  // Server-side cosmetics shop; webhook body is verified before anything is awarded.
  const premium = createPremiumShop({ cfg, reg, sameOrigin, keyOf, log });
  premium.mountGlobal(app);

  app.get('/api/status', (_req, res) => res.set('Cache-Control', NO_STORE).json(multiStatus(hh)));

  // the landing page's GitHub star count, asked by this server at most once an hour (no visitor's browser talks to
  // GitHub): { stars: n } or { stars: null } (the page then shows no number). cfg.stars (tests): { url, fetcher, wall }
  const stars = new StarCount({ url: mc.starsUrl, log, ...(cfg.stars || {}) });
  hh.stars = stars;
  app.get('/api/stars', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=900');
    return res.json({ stars: await stars.get() });
  });

  app.post('/api/farms', sameOrigin, express.json({ limit: '1kb' }), async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    if (reg.count >= mc.maxFarms) {
      return res.status(503).json({ error: 'FULL', message: 'Harness Hollow is full right now. Please try again later.' });
    }
    const r = create.take(ipOf(req));
    if (!r.ok) {
      const s = Math.ceil(r.retryAfterMs / 1000);
      res.set('Retry-After', String(s));
      return res.status(429).json({ error: 'RATE', retryAfter: s, message: 'Too many new farms from here. Please try again later.' });
    }
    const tz = req.body && typeof req.body.tz === 'string' && req.body.tz.length <= 64 && isTimeZone(req.body.tz) ? req.body.tz : null;
    try {
      const { id, secret } = await reg.create({ tz });
      return res.status(201).json({ id, secret });
    } catch (err) {
      log.error('creating a farm failed', redactArg(err));
      return res.status(500).json({ error: 'INTERNAL' });
    }
  });

  // players' ideas (POST /api/ideas) and their admin list (/api/admin/ideas, only with HH_ADMIN_TOKEN): server/ideas.js
  mountIdeas(app, hh, { sameOrigin });

  const farmApi = express.Router({ mergeParams: true });
  farmApi.use((req, res, next) => {
    res.set('Cache-Control', NO_STORE);
    if (!ID_RE.test(req.params.id)) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const r = lookups.take(ipOf(req));
    if (!r.ok) return res.set('Retry-After', String(Math.ceil(r.retryAfterMs / 1000))).status(429).json({ error: 'RATE' });
    if (!reg.has(req.params.id)) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return next();
  });

  farmApi.get('/status', async (req, res) => {
    const { id } = req.params;
    const key = keyOf(req);
    const join = typeof req.query.join === 'string' && KEY_RE.test(req.query.join) ? req.query.join : null;
    // only a request that carries a key loads a sleeping farm; a bare lookup answers from the registry
    let rec;
    try { rec = key || join ? await reg.acquire(id) : reg.rec(id); } catch { return res.status(503).json({ ok: false, error: 'UNAVAILABLE' }); }
    if (!rec) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const out = { ok: true, id, buildHash: hh.static.build, ttlDays: mc.ttlDays, slots: cfg.slots ?? 2 };
    const h = rec.host;
    try {
      out.full = h ? await h.call('full') : (rec.meta.members || 0) + (rec.meta.reserve ? 1 : 0) >= (cfg.slots ?? 2);
      if (h && join) out.invite = (await h.call('inviteState', join)) ?? 'invalid';
      if (h && key) {
        const g = await h.call('grantOf', key);
        out.member = Boolean(g && g.kind === 'member');
        if (out.member) out.pid = g.pid;
        if (g && g.kind === 'creator') out.creator = true;
        if (out.member) out.waiting = await h.call('waiting');
      }
    } catch { return res.status(503).json({ ok: false, error: 'UNAVAILABLE' }); }
    return res.json(out);
  });

  farmApi.post('/invite', sameOrigin, express.json({ limit: '1kb' }), async (req, res) => {
    const key = keyOf(req);
    if (!key) return res.status(401).json({ error: 'AUTH' });
    const r = invites.take(ipOf(req));
    if (!r.ok) return res.set('Retry-After', String(Math.ceil(r.retryAfterMs / 1000))).status(429).json({ error: 'RATE' });
    let rec;
    try { rec = await reg.acquire(req.params.id); } catch { return res.status(503).json({ ok: false, error: 'UNAVAILABLE' }); }
    if (!rec) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    try {
      const g = await rec.host.call('grantOf', key);
      if (!g || g.kind !== 'member') return res.status(403).json({ error: 'AUTH' });
      if (await rec.host.call('full')) return res.status(409).json({ error: 'FULL' });
      return res.status(201).json(await reg.invite(rec, g.pid));
    } catch (err) {
      log.error('making an invite failed', redactArg(err));
      return res.status(500).json({ error: 'INTERNAL' });
    }
  });

  farmApi.post('/rekey', sameOrigin, express.json({ limit: '1kb' }), async (req, res) => {
    const key = keyOf(req);
    if (!key) return res.status(401).json({ error: 'AUTH' });
    const ip = ipOf(req);
    const r = rekeys.take(ip);
    if (!r.ok) return res.set('Retry-After', String(Math.ceil(r.retryAfterMs / 1000))).status(429).json({ error: 'RATE' });
    let rec;
    try { rec = await reg.acquire(req.params.id); } catch { return res.status(503).json({ ok: false, error: 'UNAVAILABLE' }); }
    if (!rec) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    let g;
    let players;
    try {
      g = await rec.host.call('grantOf', key);
      players = await rec.host.call('players');
    } catch { return res.status(503).json({ ok: false, error: 'UNAVAILABLE' }); }
    if (!g || g.kind !== 'member') return res.status(403).json({ error: 'AUTH' });
    const pid = req.body && typeof req.body.pid === 'string' ? req.body.pid : null;
    if (!pid || !PLAYER_SLOTS.includes(pid) || pid === g.pid || !players.includes(pid)) {
      return res.status(400).json({ error: 'BAD_REQUEST' });
    }
    const f = rekeysFarm.take(req.params.id);
    if (!f.ok) return res.set('Retry-After', String(Math.ceil(f.retryAfterMs / 1000))).status(429).json({ error: 'RATE' });
    try {
      const made = await reg.rekey(rec, g.pid, pid);
      if (made.error === 'BAD') return res.status(400).json({ error: 'BAD_REQUEST' });
      if (made.error) return res.status(500).json({ error: 'INTERNAL' });
      return res.status(201).json(made);
    } catch (err) {
      log.error('making a new key failed', redactArg(err));
      return res.status(500).json({ error: 'INTERNAL' });
    }
  });

  // "Delete this farm now" (Settings > Farm): any farmer of the farm; everything goes at once, for both farmers
  farmApi.post('/delete', sameOrigin, express.json({ limit: '1kb' }), async (req, res) => {
    const key = keyOf(req);
    if (!key) return res.status(401).json({ error: 'AUTH' });
    const r = deletes.take(ipOf(req));
    if (!r.ok) {
      const s = Math.ceil(r.retryAfterMs / 1000);
      return res.set('Retry-After', String(s)).status(429).json({ error: 'RATE', retryAfter: s });
    }
    let rec;
    try { rec = await reg.acquire(req.params.id); } catch { return res.status(503).json({ ok: false, error: 'UNAVAILABLE' }); }
    if (!rec) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    let g;
    try { g = await rec.host.call('grantOf', key); } catch { return res.status(503).json({ ok: false, error: 'UNAVAILABLE' }); }
    if (!g || g.kind !== 'member') return res.status(403).json({ error: 'AUTH' });
    try {
      hh.harness?.onFarmDeleted(req.params.id);
      if (!(await reg.remove(rec, { by: g.pid }))) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      return res.json({ ok: true });
    } catch (err) {
      log.error('deleting a farm failed', redactArg(err));
      return res.status(500).json({ error: 'INTERNAL' });
    }
  });

  if (cfg.dev) {
    const farmOf = async (req) => (await reg.acquire(req.params.id).catch(() => null))?.host ?? null;
    const extra = express.Router({ mergeParams: true });
    extra.use((req, res, next) => (isLoopback(req.socket.remoteAddress) ? next() : res.status(403).json({ error: 'loopback only' })));
    // Unload now (a test of the sleep -> catch-up path); refused while a socket is open.
    extra.post('/unload', async (req, res) => {
      const rec = reg.rec(req.params.id);
      if (!rec) return res.status(404).json({ error: 'not found' });
      if (rec.host && rec.host.status().conns) return res.status(409).json({ error: 'connected' });
      rec.leaseUntil = 0;
      await reg.unload(rec);
      return res.json({ ok: true });
    });
    farmApi.use('/dev', extra, devRouter(farmOf));
    app.post('/api/dev/sweep', (req, res, next) => (isLoopback(req.socket.remoteAddress) ? next() : res.status(403).json({ error: 'loopback only' })),
      express.json({ limit: '1kb' }), async (req, res) => {
        const now = Number(req.body && req.body.now);
        const deleted = await reg.sweep(Number.isSafeInteger(now) ? now : undefined);
        res.json({ ok: true, deleted, expired: reg.lastExpired });
      });
  }
  // the in-game helper (Harness Hollow): /api/f/:id/harness/... and the mod icons /f/:id/mods/... (server/harness)
  if (hh.harness) {
    hh.harness.receiverRoutes(app);
    farmApi.use('/harness', hh.harness.router);
    hh.harness.mountAssets(app);
  }
  premium.mountFarm(farmApi);
  app.use('/api/f/:id', farmApi);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
  // Express's default handler prints the stack (a path may name a farm): a body that is not JSON is the client's
  // mistake (400, not logged); anything else is logged with farm ids redacted.
  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) log.error('request failed', redactArg(err));
    if (res.headersSent) return res.end();
    return res.status(status).json({ error: status === 500 ? 'INTERNAL' : 'BAD_REQUEST' });
  });
  return app;
}

/**
 * Start the multi-farm host. Resolves once listening.
 * @returns {Promise<{ port: number, hh: object, close: () => Promise<void>, banner: string }>}
 */
export async function startMultiServer(cfg) {
  const mc = cfg.multi ?? multiConfig({});
  // every host line is redacted too: an uncaught error's stack or a library message may carry a farm's path
  const log = redactLog(cfg.log || createLogger({ quiet: cfg.quiet, json: cfg.logJson }));
  const perf = new Perf();
  const staticFiles = new StaticFiles({ root: cfg.root, log });
  const reg = new FarmRegistry({ cfg, mc, log, perf, staticFiles });
  const stored = reg.scan();
  const hh = { cfg, mc, log, reg, perf, static: staticFiles, startedAt: Date.now() };
  const sockets = new Counter();
  hh.sockets = sockets;

  const { createMultiHarness } = await import('./harness/index.js');
  hh.harness = await createMultiHarness(hh);
  const app = createMultiApp(hh);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: LIMITS.MAX_PAYLOAD, perMessageDeflate: WS_DEFLATE,
    verifyClient: (info, cb) => {
      const { req } = info;
      const origin = req.headers.origin;
      if (origin) {
        let ok = false;
        try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; }
        if (!ok) return cb(false, 403);           // same origin only (tech §7 rule 8)
      }
      const ip = clientIp(req, mc.trustProxy);
      // a handshake is a farm lookup like GET /api/f/:id/status: one shared per-address budget, so guessing ids over
      // sockets is as slow as over HTTP
      if (!hh.lookups.take(ip).ok) return cb(false, 429);
      let id = null;
      try { id = new URL(req.url, 'http://x').searchParams.get('farm'); } catch { id = null; }
      if (!ID_RE.test(id || '') || !reg.has(id)) return cb(false, 404);
      if (sockets.get(ip) >= mc.wsPerIp) return cb(false, 429);
      // counted from the handshake to the socket's end, whatever happens in between (the TCP close always comes)
      sockets.add(ip);
      req.socket.once('close', () => sockets.drop(ip));
      req.hhIp = ip;
      return reg.acquire(id).then((rec) => {
        if (!rec) return cb(false, 404);
        reg.lease(rec);
        req.hhFarm = rec;
        return cb(true);
      }, () => cb(false, 503));                     // logged (redacted) by the registry
    } });
  wss.on('error', () => {});
  wss.on('connection', (ws, req) => {
    const rec = req.hhFarm;
    const host = rec && rec.host;
    if (!host) { ws.close(1013, 'farm unavailable'); return; }   // unloaded in between (should not happen: leased)
    // a farm's connection holds only the address's network (maskIp): it is used for nothing but the abuse warning's
    // log line (server/router.js); the full address stays in the per-address counters above, in memory
    host.attach(ws, maskIp(req.hhIp));
  });
  const prune = setInterval(() => { for (const l of hh.limiters) l.prune(); }, 10 * 60_000);
  prune.unref?.();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, resolve);
    });
  } catch (err) {
    clearInterval(prune);
    perf.stop();
    throw err;
  }
  reg.start();
  const port = server.address().port;
  hh.harness?.listening(port);
  let closing = null;
  const close = () => {
    closing ??= (async () => {
      clearInterval(prune);
      wss.close();
      const done = new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await reg.closeAll();                         // every loaded farm: sockets closed, final snapshot
      await hh.harness?.stop();
      await done;
      perf.stop();
    })();
    return closing;
  };
  const text = [
    'Harness Hollow — multi-farm host',
    `  running at http://localhost:${port}`,
    `  data: ${cfg.dataDir} (${stored} farm(s) stored, up to ${mc.maxFarms}; deleted after ${mc.ttlDays} days without a visit)`,
    cfg.dev ? '  DEV routes are ON (loopback only)' : null,
  ].filter(Boolean).join('\n');
  return { port, hh, close, banner: text };
}
