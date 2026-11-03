// The farm registry of the multi-farm host (HH_MODE=multi, server/multi.js): every farm lives in
// <HH_DATA_DIR>/farms/<id>/ with its own snapshot, journal and backups (server/persist.js, fewer backups than a
// single-farm server keeps) and, while loaded, its own engine, sessions, presence, together time and scheduler
// (openFarm in server/app.js, the same wiring a single-farm server boots with).
//
//   farm-meta.json  { v, id, createdAt, lastSeenAt, members, tz, reserve: { slot, hash } | null,
//                     invite: { hash, at, exp, by } | null, pastInvites: [hash],
//                     rejoin: { [pid]: { hash, at, exp, by } }, pastRejoins: [hash], revoked: [{ hash, pid, at }] }
//                   (hashes only: a key never touches the disk)
//
// Lifecycle:
//   - load on demand (a socket for the farm, an invite request, a status call carrying a key); a farm that slept
//     catches up exactly like a restarted single-farm server (openFarm: replay, awayAtBoot, scheduler catch-up)
//   - unload (stop, final snapshot, journal closed) after idleMs with no socket; an LRU cap (maxLoaded) unloads the
//     least recently used idle farm first when another one must load (a soft cap: farms with sockets stay)
//   - retention: a farm no player has been connected to for ttlDays is deleted by the sweep (hourly); a farm with a
//     socket open, loading, or leased by a socket handshake is never deleted. The same sweep runs `sweepers` (the
//     ideas and privacy requests: a year at most, server/ideas.js)
//
// Farm ids are 12 base32 characters (60 bits) from crypto.randomInt and are not logged either: log lines carry
// `farm=<first 8 hex of sha256(id)>`.
//
// Harness Hollow (docs/agent-notes/harness-contract.md §2.4): every loaded farm is reached through its FarmHost
// (rec.host, server/farm-host.js). A farm whose harness dir names an active mod (farms/<id>/harness/mods/active.json)
// loads as a WorkerFarm (its own thread, its own content with its mod); the others stay in-process (LocalFarm, rec.hh
// as before). At most HH_MOD_WORKERS_MAX modded farms are loaded at once; above that a modded farm is unavailable (503)
// like a farm that fails to load. toWorker(rec) moves an in-process farm into its worker for its first mod: saved,
// unloaded, its sockets closed with CLOSE.MOD_RELOAD (the page reconnects quietly), loaded again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openFarm } from './app.js';
import { FarmSessions, sha256, newSecret, newInviteToken, parseHello, REJOIN_TTL_MS, MF_ERR } from './farm-sessions.js';
import { parseClientMessage, CLOSE } from '../shared/net/protocol.js';
import { LocalFarm, WorkerFarm } from './farm-host.js';

export const ID_RE = /^[a-z2-7]{12}$/;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export const META = 'farm-meta.json';
/** Invites expire after this long (or when the farm is full, or when a new one replaces them). */
export const INVITE_TTL_MS = 7 * 86_400_000;
/** A rejoin link (a farmer's new key) works this long, once (farm-sessions.js). */
export { REJOIN_TTL_MS };
/** A socket handshake holds its farm loaded this long before the connection exists. */
const LEASE_MS = 15_000;
/** While players are connected, lastSeenAt is written to disk at least this often (a crash keeps it recent). */
const SEEN_WRITE_MS = 10 * 60_000;

export const newFarmId = () => Array.from({ length: 12 }, () => B32[crypto.randomInt(32)]).join('');
/** The farm's name in log lines: never the id itself (the id is half of a farm's address). */
export const farmTag = (id) => sha256(id).slice(0, 8);

/** tmp + fsync + rename (+ dir fsync): small JSON files written synchronously. */
function writeJsonSync(file, obj) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const d = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  } catch { /* some filesystems refuse a directory fsync; the rename is still atomic */ }
}

/** Any farm id inside a path or message (`.../farms/<id>/...`) becomes its tag: paths in errors must not leak ids. */
export function redact(text) {
  return String(text).replace(/(farms[\\/])([a-z2-7]{12})(?![a-z2-7])/g, (_m, pre, id) => `${pre}<${farmTag(id)}>`);
}

/** A copy of a log argument with every farm id redacted (strings, plain-object fields, an Error's message). */
export function redactArg(a) {
  if (typeof a === 'string') return redact(a);
  if (a instanceof Error) {
    const e = new Error(redact(a.message));
    if (a.code) e.code = a.code;
    e.stack = redact(a.stack || '');
    return e;
  }
  if (a !== null && typeof a === 'object' && !Array.isArray(a)) {
    return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]));
  }
  return a;
}

/** A logger whose every argument is redacted (the host's own lines: an uncaught error's stack may name a farm). */
export function redactLog(log) {
  const wrap = (fn) => (...args) => fn(...args.map(redactArg));
  return { info: wrap(log.info), log: wrap(log.log || log.info), warn: wrap(log.warn), error: wrap(log.error) };
}

/** A logger whose lines carry the farm's tag and never its id (a farm's own messages name its files). */
export function farmLog(log, id) {
  const tag = { farm: farmTag(id) };
  const wrap = (fn) => (...args) => {
    const a = args.map(redactArg);
    const i = a.findIndex((x) => x !== null && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Error));
    if (i >= 0) a[i] = { ...tag, ...a[i] };
    else a.push(tag);
    return fn(...a);
  };
  return { info: wrap(log.info), log: wrap(log.log || log.info), warn: wrap(log.warn), error: wrap(log.error) };
}

/** The host's own heartbeat (farms/host.json): a long outage must not count as days nobody visited. */
const HOST = 'host.json';

export class FarmRegistry {
  /**
   * @param {{ cfg: object, mc: object, log: Console, perf?: object|null, staticFiles?: object|null,
   *   wall?: () => number }} o  mc = cfg.multi (config.multiConfig)
   */
  constructor({ cfg, mc, log, perf = null, staticFiles = null, wall = Date.now }) {
    Object.assign(this, { cfg, mc, log, perf, staticFiles, wall });
    this.root = path.join(cfg.dataDir, 'farms');
    /** id -> record { id, dir, meta, hh, loading, unloading, lastUsed, idleSince, leaseUntil, seenWrittenAt } */
    this.recs = new Map();
    this.timers = [];
    this.stats = { loads: 0, unloads: 0, created: 0, deleted: 0 };
    /** more retention, run by every sweep after the farms: async (now) => summary (server/ideas.js: a year at most) */
    this.sweepers = [];
    /** what the sweepers did on the last sweep (the dev sweep route shows it) */
    this.lastExpired = [];
  }

  /** Boot: index every farm directory (only its small meta file is read). */
  scan() {
    fs.mkdirSync(this.root, { recursive: true });
    for (const ent of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ID_RE.test(ent.name)) continue;
      const dir = path.join(this.root, ent.name);
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8'));
        if (!meta || meta.id !== ent.name) throw new Error('not this farm\'s meta');
      } catch {
        // No meta (a crash during the creation, or a hand-copied farm): rebuilt from what is on disk.
        let at;
        try { at = fs.statSync(path.join(dir, 'farm.json')).mtimeMs; } catch { at = null; }
        if (at === null) {
          this.log.warn('a farm directory without a save or meta was skipped', { farm: farmTag(ent.name) });
          continue;
        }
        meta = { v: 1, id: ent.name, createdAt: Math.floor(at), lastSeenAt: Math.floor(at), members: 0, tz: null, reserve: null, invite: null };
        this.log.warn('farm meta rebuilt from the save', { farm: farmTag(ent.name) });
      }
      this.recs.set(ent.name, this.record(ent.name, meta));
    }
    this.creditDowntime();
    return this.recs.size;
  }

  /**
   * Boot: when the host itself was down (no heartbeat for more than two sweeps), nobody could visit, so every farm's
   * last visit moves forward by the outage (written, so a second restart keeps the credit).
   */
  creditDowntime() {
    const now = this.wall();
    let aliveAt = null;
    try { aliveAt = JSON.parse(fs.readFileSync(path.join(this.root, HOST), 'utf8')).aliveAt; } catch { aliveAt = null; }
    const down = Number.isSafeInteger(aliveAt) ? now - aliveAt : 0;
    if (down > 2 * this.mc.sweepMs) {
      for (const rec of this.recs.values()) {
        rec.meta.lastSeenAt = Math.min(now, (Number.isFinite(rec.meta.lastSeenAt) ? rec.meta.lastSeenAt : rec.meta.createdAt) + down);
        try { this.saveMeta(rec); } catch (err) { this.log.error('farm meta write failed', { farm: farmTag(rec.id) }, redactArg(err)); }
      }
      this.log.warn(`the host was down for ${Math.round(down / 3_600_000)} h; every farm keeps those days`, { farms: this.recs.size });
    }
    this.heartbeat();
  }

  /** Written at boot, at every sweep and at shutdown. */
  heartbeat() {
    try { writeJsonSync(path.join(this.root, HOST), { aliveAt: this.wall() }); } catch (err) { this.log.error('host heartbeat write failed', redactArg(err)); }
  }

  record(id, meta) {
    return { id, dir: path.join(this.root, id), meta, hh: null, host: null, loading: null, unloading: null, lastUsed: 0,
      idleSince: null, leaseUntil: 0, seenWrittenAt: 0, pendingHx: [] };
  }

  get count() { return this.recs.size; }
  get loadedCount() { let n = 0; for (const r of this.recs.values()) if (r.host) n++; return n; }
  get workerCount() { let n = 0; for (const r of this.recs.values()) if (r.host && r.host.kind === 'worker') n++; return n; }

  /** The farm's harness dir (its mods, jobs, consent and sign-ins: deleted with the farm). */
  harnessDir(rec) { return path.join(rec.dir, 'harness'); }

  /** True when the farm has a mod (it runs in its own worker thread). */
  modded(rec) { return fs.existsSync(path.join(this.harnessDir(rec), 'mods', 'active.json')); }
  has(id) { return typeof id === 'string' && this.recs.has(id); }
  rec(id) { return this.has(id) ? this.recs.get(id) : null; }

  saveMeta(rec) {
    writeJsonSync(path.join(rec.dir, META), rec.meta);
  }

  /** Create a farm: { id, secret }. The farm is loaded (its creator connects next) and durable before this resolves. */
  async create({ tz = null } = {}) {
    let id;
    do id = newFarmId(); while (this.recs.has(id) || fs.existsSync(path.join(this.root, id)));
    const secret = newSecret();
    const now = this.wall();
    const rec = this.record(id, { v: 1, id, createdAt: now, lastSeenAt: now, members: 0, tz,
      reserve: { slot: 'p1', hash: sha256(secret) }, invite: null });
    fs.mkdirSync(rec.dir, { recursive: true });
    this.saveMeta(rec);
    this.recs.set(id, rec);
    try {
      await this.acquire(id);
    } catch (err) {
      this.recs.delete(id);
      fs.rmSync(rec.dir, { recursive: true, force: true });
      throw err;
    }
    this.stats.created++;
    this.log.info('a farm was created', { farm: farmTag(id), farms: this.recs.size });
    return { id, secret };
  }

  /** The loaded farm record (loading it when needed), or null for an unknown id. */
  async acquire(id) {
    const rec = this.rec(id);
    if (!rec) return null;
    rec.lastUsed = this.wall();
    this.lease(rec);                    // neither the sweep nor the idle check takes it while the caller uses it
    while (rec.unloading) await rec.unloading;
    if (this.recs.get(id) !== rec) return null;           // deleted by a sweep that was already under way
    if (rec.host) return rec;
    rec.loading ??= this.load(rec).finally(() => { rec.loading = null; });
    await rec.loading;
    rec.lastUsed = this.wall();
    return this.recs.get(id) === rec ? rec : null;
  }

  async load(rec) {
    await this.makeRoom(rec);
    const cfg = { ...this.cfg, dataDir: rec.dir, passphrase: null, tz: rec.meta.tz || this.cfg.tz, tzExplicit: false };
    if (this.modded(rec)) return this.loadWorker(rec, cfg);
    const hooks = {
      meta: rec.meta,
      wall: this.wall,
      saveMeta: () => {
        try { this.saveMeta(rec); } catch (err) { this.log.error('farm meta write failed', { farm: farmTag(rec.id) }, redactArg(err)); }
      },
      onConns: (n) => { rec.idleSince = n ? null : this.wall(); },
      onJoin: () => this.seen(rec, true),
      onLeave: () => this.seen(rec, true),
    };
    let hh;
    try {
      hh = await openFarm(cfg, { log: farmLog(this.log, rec.id), dir: rec.dir, perf: this.perf, staticFiles: this.staticFiles,
        persistOpts: { backupHours: this.mc.backupHours, backupDays: this.mc.backupDays },
        makeSessions: (o) => new FarmSessions(o, hooks) });
    } catch (err) {
      // a refused boot of one farm (a journal that does not replay...) keeps its files for a human; the host goes on
      this.log.error('a farm could not be loaded; its files are kept as they are', { farm: farmTag(rec.id) }, redactArg(err));
      throw new Error('farm unavailable');
    }
    hh.farmId = rec.id;
    hh.parse = parseHello(parseClientMessage);       // + hello.join (farm-sessions.js)
    hh.presence.start();
    hh.sessions.startHeartbeat();
    rec.hh = hh;
    rec.host = new LocalFarm(hh);
    rec.idleSince = this.wall();
    this.stats.loads++;
    return rec;
  }

  /** A modded farm: its own worker thread (server/farm-worker.js). */
  async loadWorker(rec, cfg) {
    const max = this.cfg.harness?.modWorkersMax ?? 16;
    if (this.workerCount >= max) {
      // the LRU frees an idle modded farm first; with none idle the farm is unavailable for now
      const idle = [...this.recs.values()].filter((r) => r !== rec && r.host?.kind === 'worker' && this.unloadable(r))
        .sort((a, b) => a.lastUsed - b.lastUsed);
      if (idle.length) await this.unload(idle[0]);
      else {
        this.log.warn('every modded farm slot is in use; a modded farm is unavailable for now', { farm: farmTag(rec.id), max });
        throw new Error('farm unavailable');
      }
    }
    // the host's build hash, not the worker's own: a file saved after the host started gave the worker's welcome another
    // hash and every page of the farm reloaded (QA r4, harvey's e2e-harness --multi)
    const host = new WorkerFarm({ cfg, dir: rec.dir, harnessDir: this.harnessDir(rec), meta: rec.meta, log: farmLog(this.log, rec.id),
      build: this.staticFiles?.build ?? null,
      persistOpts: { backupHours: this.mc.backupHours, backupDays: this.mc.backupDays }, pendingHx: rec.pendingHx.splice(0),
      onMeta: (meta) => {
        // the worker's FarmSessions changed the meta (a claim, a new key): the main thread is its only writer
        const { lastSeenAt: _ignored, ...rest } = meta;
        Object.assign(rec.meta, rest);
        try { this.saveMeta(rec); } catch (err) { this.log.error('farm meta write failed', { farm: farmTag(rec.id) }, redactArg(err)); }
      },
      onEvent: (ev) => {
        if (ev.e === 'conns') rec.idleSince = ev.n ? null : this.wall();
        else if (ev.e === 'join' || ev.e === 'leave') this.seen(rec, true);
      },
      onExit: (code) => {
        // a crash stays inside one farm: it is marked unloaded and the next socket loads it again
        if (rec.host !== host) return;
        rec.host = null;
        rec.idleSince = null;
        this.stats.unloads++;
        this.log.error('a modded farm\'s worker stopped unexpectedly; it loads again on the next visit', { farm: farmTag(rec.id), code });
      } });
    try {
      await host.start();
    } catch (err) {
      this.log.error('a modded farm could not be loaded; its files are kept as they are', { farm: farmTag(rec.id) }, redactArg(err));
      throw new Error('farm unavailable');
    }
    rec.hh = null;
    rec.host = host;
    rec.idleSince = this.wall();
    this.stats.loads++;
    return rec;
  }

  /**
   * Move an in-process farm into its worker for its first mod (harness contract §2.4): saved and unloaded with its
   * sockets closed as CLOSE.MOD_RELOAD, then `before()` (the mod store makes the version active), then loaded again
   * (now as a WorkerFarm). `hx`: the harness push its farmers get after they reconnect.
   */
  async toWorker(rec, { before = () => {}, hx = null } = {}) {
    if (rec.host) await this.unload(rec, { code: CLOSE.MOD_RELOAD, reason: 'mod applied' });
    before();
    if (hx) rec.pendingHx.push(hx);
    return this.acquire(rec.id);
  }

  /** Before a load: unload the least recently used idle farms while the cap is reached. */
  async makeRoom(self = null) {
    while (this.loadedCount >= this.mc.maxLoaded) {
      const idle = [...this.recs.values()].filter((r) => r !== self && this.unloadable(r)).sort((a, b) => a.lastUsed - b.lastUsed);
      if (!idle.length) {
        this.log.warn('every loaded farm has players; loading one more over the cap', { loaded: this.loadedCount, cap: this.mc.maxLoaded });
        return;
      }
      await this.unload(idle[0]);
    }
  }

  /** Loaded, nobody connected, no handshake in flight. */
  unloadable(rec) {
    return Boolean(rec.host && !rec.unloading && !rec.loading && rec.host.status().conns === 0 && rec.leaseUntil <= this.wall());
  }

  /** Stop the farm, write its final snapshot, free it. `o.code`: the close code its sockets get. */
  unload(rec, o = undefined) {
    if (!rec.host) return rec.unloading || Promise.resolve();
    rec.unloading ??= (async () => {
      const host = rec.host;
      try {
        await host.stop(o);
        await host.finish();
      } catch (err) {
        this.log.error('unloading a farm failed', { farm: farmTag(rec.id) }, redactArg(err));
      } finally {
        rec.hh = null;
        rec.host = null;
        rec.idleSince = null;
        rec.unloading = null;
        this.stats.unloads++;
      }
    })();
    return rec.unloading;
  }

  /** A player arrived or left (or is still here): lastSeenAt is now; written at once, or every SEEN_WRITE_MS. */
  seen(rec, force = false) {
    const now = this.wall();
    rec.meta.lastSeenAt = now;
    if (force || now - rec.seenWrittenAt >= SEEN_WRITE_MS) {
      rec.seenWrittenAt = now;
      try { this.saveMeta(rec); } catch (err) { this.log.error('farm meta write failed', { farm: farmTag(rec.id) }, redactArg(err)); }
    }
  }

  /** A socket handshake for this farm is in flight: keep it loaded until the connection exists. */
  lease(rec) { rec.leaseUntil = this.wall() + LEASE_MS; }

  /** Every 30 s: unload idle farms; keep lastSeenAt of farms with players fresh. */
  async idleCheck() {
    const now = this.wall();
    for (const rec of [...this.recs.values()]) {
      if (!rec.host) continue;
      if (rec.host.status().online.length) this.seen(rec);
      if (this.unloadable(rec) && rec.idleSince !== null && now - rec.idleSince >= this.mc.idleMs) await this.unload(rec);
    }
  }

  /** True while somebody is at the farm (a socket, a handshake, a load in progress). */
  busy(rec) {
    return Boolean(rec.loading || rec.unloading || rec.leaseUntil > this.wall() || (rec.host && rec.host.status().conns));
  }

  /** Retention: delete every farm nobody connected to for ttlDays. Returns how many were deleted. */
  async sweep(now = this.wall()) {
    this.heartbeat();
    const ttl = this.mc.ttlDays * 86_400_000;
    let n = 0;
    for (const rec of [...this.recs.values()]) {
      if (this.busy(rec)) continue;
      // Never expire a farm with a purchased cosmetic; it remains until its owner deletes it.
      if (this.premiumRetain?.(rec.id)) continue;
      const last = Number.isFinite(rec.meta.lastSeenAt) ? rec.meta.lastSeenAt : rec.meta.createdAt;
      if (!(now - last >= ttl)) continue;
      if (rec.host) await this.unload(rec);
      if (this.busy(rec) || this.recs.get(rec.id) !== rec) continue;       // somebody arrived meanwhile
      this.recs.delete(rec.id);
      this.removeDir(rec);
      n++;
      this.stats.deleted++;
      this.log.info(`a farm nobody visited for ${this.mc.ttlDays} days was deleted`, { farm: farmTag(rec.id) });
    }
    const expired = [];
    for (const fn of this.sweepers) {
      try { expired.push(await fn(now)); } catch (err) { this.log.error('retention sweep failed', redactArg(err)); }
    }
    this.lastExpired = expired;
    return n;
  }

  /** The farm's folder (snapshot, journals, backups, incidents, meta), removed: only ever a farm directory under farms/. */
  removeDir(rec) {
    if (path.dirname(rec.dir) === this.root && ID_RE.test(path.basename(rec.dir))) fs.rmSync(rec.dir, { recursive: true, force: true });
  }

  /**
   * "Delete this farm now" (a farmer's own request, server/multi.js POST /api/f/:id/delete): from this moment the farm
   * is unknown to every route and handshake; every open screen hears `deny DELETED` and its socket closes; the farm
   * stops; its whole folder (backups included) is removed. `by`: the farmer who asked (logged, with the farm's tag), or
   * null for the owner acting on a privacy request (DELETE /api/admin/farms/:id). Resolves false when the farm was
   * already gone.
   */
  async remove(rec, { by = null } = {}) {
    if (this.recs.get(rec.id) !== rec) return false;
    this.recs.delete(rec.id);
    if (rec.loading) await rec.loading.catch(() => {});
    if (rec.unloading) await rec.unloading;
    if (rec.host) await rec.host.call('denyAll', MF_ERR.DELETED).catch(() => {});
    // stopped like an unload (graces ended, the journal flushed and closed), so no write lands after the removal
    await this.unload(rec);
    this.removeDir(rec);
    this.stats.deleted++;
    if (by) this.log.info('a farm was deleted by one of its farmers', { farm: farmTag(rec.id), pid: by });
    else this.log.info('a farm was deleted on a privacy request', { farm: farmTag(rec.id) });
    return true;
  }

  /** A new invite for `pid` (replaces the old one) on a loaded farm. Durable before it is returned. */
  async invite(rec, pid) {
    const token = newInviteToken();
    const at = this.wall();
    await rec.host.call('retireInvite');
    rec.meta.invite = { hash: sha256(token), at, exp: at + INVITE_TTL_MS, by: pid };
    this.saveMeta(rec);
    if (rec.host.kind === 'worker') await rec.host.call('setMeta', { invite: rec.meta.invite, pastInvites: rec.meta.pastInvites });
    return { token, expiresAt: rec.meta.invite.exp };
  }

  /**
   * A new key for farmer `slot`, made by farmer `by`, on a loaded farm: { pid, token, expiresAt } (the token is the
   * rejoin link's, 128 bits, kept here only as its hash), or { error } ('BAD', or an engine code). Durable before it
   * is returned: the turned-off keys ride on the journal line, the rejoin hash on the meta file.
   */
  async rekey(rec, by, slot) {
    const token = newInviteToken();
    const at = this.wall();
    const exp = at + REJOIN_TTL_MS;
    const err = await rec.host.call('rekey', by, slot, { hash: sha256(token), at, exp });
    if (err) return { error: err };
    this.saveMeta(rec);
    return { pid: slot, token, expiresAt: exp };
  }

  start() {
    const idle = setInterval(() => { this.idleCheck().catch((err) => this.log.error('idle check failed', redactArg(err))); },
      Math.min(30_000, Math.max(1000, Math.floor(this.mc.idleMs / 2))));
    const sweep = setInterval(() => { this.sweep().catch((err) => this.log.error('retention sweep failed', redactArg(err))); }, this.mc.sweepMs);
    idle.unref?.();
    sweep.unref?.();
    this.timers.push(idle, sweep);
    this.sweep().catch((err) => this.log.error('retention sweep failed', redactArg(err)));
  }

  /** Shutdown: every loaded farm stops and writes its final snapshot. */
  async closeAll() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.all([...this.recs.values()].map((r) => (r.loading ? r.loading.catch(() => {}) : null)));
    await Promise.all([...this.recs.values()].filter((r) => r.host).map((r) => this.unload(r)));
    this.heartbeat();
  }

  /** Aggregates for /api/status (no ids). */
  summary() {
    let loaded = 0;
    let connections = 0;
    let online = 0;
    let degraded = false;
    let saveError = false;
    let modded = 0;
    for (const r of this.recs.values()) {
      if (!r.host) continue;
      const st = r.host.status();
      loaded++;
      if (r.host.kind === 'worker') modded++;
      connections += st.conns;
      online += st.online.length;
      if (st.degraded) degraded = true;
      if (st.saveError) saveError = true;
    }
    return { stored: this.recs.size, loaded, connections, online, max: this.mc.maxFarms, maxLoaded: this.mc.maxLoaded,
      degraded, saveError, modded, ...this.stats };
  }
}
