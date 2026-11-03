// Crystal Rush / Harvest Hollow: small optional cosmetic storefront.
// A browser redirect NEVER grants an item; only the verified server webhook does.
const farmMatch = /^\/f\/([A-Za-z0-9_-]{6,64})\/?$/.exec(location.pathname);
if (farmMatch) {
  const farmId = farmMatch[1];
  const key = 'hh.f.' + farmId + '.';
  const $ = id => document.getElementById(id);
  const money = cents => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR' }).format(cents / 100);
  const modal = document.createElement('dialog');
  modal.className = 'hh-premium-dialog';
  modal.innerHTML = `
    <header class="hh-premium-head">
      <div><span class="hh-premium-eyebrow">✨ МАГАЗИН УКРАШЕНИЙ</span><h2>Волшебные вещи</h2>
      <p>Покупки необязательны. Они меняют только оформление игры, не дают преимущества.</p></div>
      <button class="hh-premium-close" type="button" aria-label="Закрыть">✕</button>
    </header>
    <div id="hh-premium-list" class="hh-premium-grid"></div>
    <p id="hh-premium-status" class="hh-premium-status" role="status" aria-live="polite"></p>
    <footer class="hh-premium-foot">Оплата через защищённую страницу Stripe. Покупка прикрепляется к вашему игроку в этой ферме. При удалении фермы доступ к украшению теряется. <a href="/privacy" target="_blank" rel="noopener">Конфиденциальность</a></footer>`;
  document.body.append(modal);
  const open = document.createElement('button');
  open.id = 'hh-premium-open';
  open.type = 'button';
  open.textContent = '✦ VIP';
  open.setAttribute('aria-label', 'Открыть магазин украшений');
  document.body.append(open);
  const badge = document.createElement('div');
  badge.id = 'hh-premium-badge';
  badge.setAttribute('aria-hidden', 'true');
  document.body.append(badge);

  let catalog = { enabled: false, mode: 'preview', items: [] };
  let owned = [];
  let shopping = false;

  function secret() {
    try {
      const activeSlot = JSON.parse(sessionStorage.getItem(key + 'slot') || 'null');
      const tokens = JSON.parse(localStorage.getItem(key + 'tokens') || '{}');
      if (activeSlot && tokens[activeSlot]) return tokens[activeSlot];
      return JSON.parse(localStorage.getItem(key + 'key') || 'null');
    } catch { return null; }
  }
  function paintCosmetics() {
    document.body.classList.toggle('hh-premium-gold', owned.includes('golden_frame'));
    document.body.classList.toggle('hh-premium-fireflies', owned.includes('fireflies'));
    document.body.classList.toggle('hh-premium-crown', owned.includes('farmer_crown'));
    badge.textContent = owned.includes('farmer_crown') ? '👑 Легендарный фермер' : '';
    if (!document.getElementById('hh-premium-fireflies')) {
      const holder = document.createElement('div');
      holder.id = 'hh-premium-fireflies';
      holder.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 20; i++) {
        const orb = document.createElement('i');
        orb.style.setProperty('--x', ((i * 41 + 17) % 100) + '%');
        orb.style.setProperty('--y', ((i * 31 + 28) % 100) + '%');
        orb.style.setProperty('--delay', (-i * 1.2) + 's');
        orb.style.setProperty('--speed', (3.5 + i % 6) + 's');
        holder.append(orb);
      }
      document.body.append(holder);
    }
  }

  async function getCatalog() {
    const res = await fetch('/api/shop/catalog', { cache: 'no-store' });
    if (!res.ok) throw new Error('Сейчас магазин недоступен.');
    catalog = await res.json();
  }
  async function syncOwned() {
    const token = secret();
    if (!token) return;
    try {
      const res = await fetch('/api/f/' + farmId + '/shop/entitlements', {
        headers: { authorization: 'Bearer ' + token }, cache: 'no-store',
      });
      if (res.ok) {
        const body = await res.json();
        if (Array.isArray(body.items)) owned = body.items;
        paintCosmetics();
      }
    } catch { /* a disconnect must not break the main game */ }
  }
  function status(text) { $('hh-premium-status').textContent = text; }
  function render() {
    const list = $('hh-premium-list');
    list.replaceChildren();
    for (const item of catalog.items) {
      const card = document.createElement('article');
      card.className = 'hh-premium-item';
      const icon = document.createElement('div');
      icon.className = 'hh-premium-icon';
      icon.textContent = item.icon;
      const title = document.createElement('h3');
      title.textContent = item.name;
      const desc = document.createElement('p');
      desc.textContent = item.description;
      const btn = document.createElement('button');
      btn.type = 'button';
      const isOwned = owned.includes(item.id);
      btn.textContent = isOwned ? '✓ УЖЕ КУПЛЕНО' : catalog.enabled ? 'Купить · ' + money(item.amount) : 'Скоро · ' + money(item.amount);
      btn.disabled = !catalog.enabled || isOwned || shopping;
      btn.onclick = () => checkout(item.id);
      card.append(icon, title, desc, btn);
      list.append(card);
    }
    if (!catalog.enabled) status('Платежи пока не подключены. Товары показаны для ознакомления — списаний нет.');
    else if (catalog.mode === 'test') status('ТЕСТОВЫЙ STRIPE: реальные деньги не списываются.');
    else status('Покупки в EUR. После оплаты товар появится здесь.');
  }

  async function checkout(sku) {
    const token = secret();
    if (!token) { status('Сначала зайдите на ферму своим персонажем, затем откройте магазин ещё раз.'); return; }
    shopping = true;
    render();
    try {
      const res = await fetch('/api/f/' + farmId + '/shop/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ sku }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) throw new Error(body.error === 'ALREADY_OWNED' ? 'У вас уже есть этот товар.' : 'Не удалось открыть Stripe Checkout.');
      location.assign(body.url);
    } catch (err) {
      shopping = false;
      render();
      status(err.message);
    }
  }

  modal.querySelector('.hh-premium-close').onclick = () => modal.close();
  modal.addEventListener('click', e => { if (e.target === modal) modal.close(); });
  open.onclick = async () => {
    try { await getCatalog(); await syncOwned(); render(); modal.showModal(); }
    catch (err) { catalog = { items: [], enabled: false, mode: 'preview' }; modal.showModal(); status(err.message); }
  };

  // The shop is game UI, not an invitation to pay before player authentication.
  const updateButton = () => { open.hidden = Boolean(document.getElementById('hud')?.hidden); };
  setInterval(updateButton, 1000);
  updateButton();
  syncOwned().catch(() => {});
  setInterval(() => { if (!document.hidden) syncOwned().catch(() => {}); }, 60000);
  const query = new URLSearchParams(location.search);
  if (query.get('shop') === 'success') {
    // Verify ownership with server; never trust the success URL itself.
    open.onclick = async () => {
      await getCatalog();
      await syncOwned();
      render();
      modal.showModal();
    };
    const poll = async () => {
      for (let i = 0; i < 8; i++) {
        await new Promise(resolve => setTimeout(resolve, 1600));
        await syncOwned();
      }
    };
    poll().catch(() => {});
    try { query.delete('shop'); query.delete('session_id'); history.replaceState(history.state, '', location.pathname + (query.size ? '?' + query : '') + location.hash); } catch {}
  } else if (query.get('shop') === 'cancel') {
    try { query.delete('shop'); history.replaceState(history.state, '', location.pathname + (query.size ? '?' + query : '') + location.hash); } catch {}
  }
}
