'use strict';
/* Notizwerk – Synchronisation über Supabase.
   Jede Seite ist eine Zeile, Notizbücher/Abschnitte liegen in der Zeile "struct".
   Konflikte: Die jüngere Änderung gewinnt (pro Seite). Seiten gehen nie verloren –
   passt eine Seite nicht mehr in die Struktur, landet sie im ersten Abschnitt. */
const Sync = (() => {
  const PAGE_SIZE = 50, CHUNK = 1.5e6, POLL = 30e3;
  let meta = { session: null, cursor: null, base: {}, baseStruct: null, dirty: {}, synced: false, last: 0 };
  let status = 'off', running = null, again = false, pushT = null;

  // ---------- Konfiguration ----------
  const conf = () => {
    let c = null; try { c = JSON.parse(localStorage.getItem('nw:supabase') || 'null'); } catch { }
    if (!c?.url) c = window.NOTIZWERK_SUPABASE || {};
    return { url: (c.url || '').trim().replace(/\/+$/, ''), key: (c.key || '').trim() };
  };
  const configured = () => { const c = conf(); return !!(c.url && c.key); };
  const loggedIn = () => !!meta.session?.refresh;
  const saveMeta = () => DB.set('sync', meta);

  // ---------- Hashes & lokale Zeilen ----------
  function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + '.' + s.length.toString(36); }
  const hcache = new WeakMap();
  function pageHash(p) {
    const k = [p.updated, p.lvl || 0, p.paper || '', p.title, p.blocks.length, p.strokes.length].join('|');
    const c = hcache.get(p); if (c && c.k === k) return c.h;
    const h = fnv(JSON.stringify(p)); hcache.set(p, { k, h }); return h;
  }
  const structOf = nbs => nbs.map(n => ({ id: n.id, name: n.name, color: n.color, sections: n.sections.map(s => ({ id: s.id, name: s.name, color: s.color, pages: s.pages.map(p => typeof p === 'string' ? p : p.id) })) }));
  function localRows() {
    const rows = new Map(), struct = { notebooks: structOf(state.notebooks) };
    rows.set('struct', { kind: 'struct', status: 'live', h: fnv(JSON.stringify(struct)), body: () => struct });
    for (const { sec, page } of allPages()) rows.set(page.id, { kind: 'page', status: 'live', h: 'L' + pageHash(page) + sec.id, body: () => ({ secId: sec.id, page }) });
    for (const t of state.trash) if (!rows.has(t.page.id)) rows.set(t.page.id, { kind: 'page', status: 'trash', h: 'T' + pageHash(t.page) + t.at, body: () => ({ secId: t.secId, where: t.where, at: t.at, page: t.page }) });
    return rows;
  }
  // Merkt sich, was sich seit dem letzten Abgleich lokal geändert hat (mit Zeitpunkt).
  function scan() {
    const now = Date.now(), rows = localRows(), d = meta.dirty, b = meta.base;
    const mark = (id, h) => { if (d[id]?.h !== h) d[id] = { h, rev: Math.max(now, (b[id]?.rev || 0) + 1) }; };
    for (const [id, r] of rows) { if (b[id]?.h === r.h) delete d[id]; else mark(id, r.h); }
    for (const id in b) if (!rows.has(id) && b[id].status !== 'gone') mark(id, 'gone');
    for (const id in d) if (!rows.has(id) && (!b[id] || b[id].status === 'gone')) delete d[id];
    return rows;
  }

  // ---------- Netzwerk ----------
  class AuthError extends Error { }
  async function call(path, { method = 'GET', body, auth = true } = {}) {
    const c = conf(), headers = { apikey: c.key, 'Content-Type': 'application/json' };
    if (auth) { await ensureToken(); headers.Authorization = 'Bearer ' + meta.session.access; }
    const r = await fetch(c.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch { }
    if (!r.ok) {
      const msg = j?.error_description || j?.msg || j?.message || j?.error || ('HTTP ' + r.status);
      const e = new Error(msg); e.status = r.status; e.code = j?.error_code || j?.code || j?.error; throw e;
    }
    return j;
  }
  const authCall = (path, body) => call('/auth/v1/' + path, { method: 'POST', body, auth: false });
  function setSession(j) {
    meta.session = { access: j.access_token, refresh: j.refresh_token, exp: j.expires_at ? j.expires_at * 1000 : Date.now() + (j.expires_in || 3600) * 1000, email: j.user?.email || meta.session?.email || '' };
  }
  async function ensureToken() {
    if (!loggedIn()) throw new AuthError('nicht angemeldet');
    if (meta.session.exp - Date.now() > 60e3) return;
    try { setSession(await authCall('token?grant_type=refresh_token', { refresh_token: meta.session.refresh })); await saveMeta(); }
    catch (e) { if (e.status >= 400 && e.status < 500) { meta.session = null; await saveMeta(); throw new AuthError('Anmeldung abgelaufen'); } throw e; }
  }

  // ---------- Remote → lokal ----------
  const mkLocalPage = p => { const q = Object.assign(mkPage(''), p, { blocks: Array.isArray(p.blocks) ? p.blocks : [], strokes: Array.isArray(p.strokes) ? p.strokes : [] }); q.blocks.forEach(b => b.html = sanitize(String(b.html || ''))); return q; };
  function findSec(nbs, id) { for (const n of nbs) for (const s of n.sections) if (s.id === id) return s; return null; }
  function removeEverywhere(id) {
    for (const n of state.notebooks) for (const s of n.sections) { const i = s.pages.findIndex(p => p.id === id); if (i >= 0) s.pages.splice(i, 1); }
    state.trash = state.trash.filter(t => t.page.id !== id);
  }
  function applyStruct(st, union) {
    const old = state.notebooks, where = new Map(), used = new Set();
    for (const n of old) for (const s of n.sections) for (const p of s.pages) where.set(p.id, { page: p, secId: s.id });
    const nbs = (st.notebooks || []).map(n => {
      const on = old.find(o => o.id === n.id);
      return { id: n.id, name: n.name, color: n.color, last: on?.last, sections: (n.sections || []).map(s => ({
        id: s.id, name: s.name, color: s.color, last: on?.sections.find(x => x.id === s.id)?.last,
        pages: (s.pages || []).map(pid => { const x = where.get(pid); if (!x || used.has(pid)) return null; used.add(pid); return x.page; }).filter(Boolean)
      })) };
    });
    if (union) for (const on of old) {
      const nn = nbs.find(x => x.id === on.id);
      if (!nn) nbs.push({ ...on, sections: on.sections.map(s => ({ ...s, pages: [] })) });
      else for (const os of on.sections) if (!nn.sections.some(x => x.id === os.id)) nn.sections.push({ ...os, pages: [] });
    }
    if (!nbs.length) nbs.push(mkNotebook('Mein Notizbuch'));
    for (const n of nbs) if (!n.sections.length) n.sections.push(mkSection('Allgemein', n.color));
    for (const [pid, x] of where) if (!used.has(pid)) (findSec(nbs, x.secId) || nbs[0].sections[0]).pages.push(x.page);
    state.notebooks = nbs;
  }
  function applyPage(r) {
    const loc = findPage(r.id);
    if (r.status === 'gone' || !r.body?.page) return removeEverywhere(r.id);
    const page = mkLocalPage(r.body.page); page.id = r.id;
    if (r.status === 'trash') {
      removeEverywhere(r.id);
      state.trash.push({ page, secId: r.body.secId, where: r.body.where || '', at: r.body.at || Date.now() });
      state.trash.sort((a, b) => b.at - a.at); return;
    }
    if (loc) { loc.sec.pages[loc.sec.pages.indexOf(loc.page)] = page; return; }
    removeEverywhere(r.id);
    (findSec(state.notebooks, r.body.secId) || state.notebooks[0].sections[0]).pages.push(page);
  }

  async function pull({ first = false, union = false } = {}) {
    if (!first) scan();
    const accepted = [], copies = [];
    let since = meta.cursor ? new Date(Date.parse(meta.cursor) - 10e3).toISOString() : null, max = meta.cursor;
    for (;;) {
      const q = `/rest/v1/nw_items?select=id,kind,status,body,rev,updated_at&order=updated_at.asc&limit=${PAGE_SIZE}` + (since ? `&updated_at=gt.${encodeURIComponent(since)}` : '');
      const rows = await call(q);
      for (const r of rows) {
        r.rev = +r.rev;
        if (!max || Date.parse(r.updated_at) > Date.parse(max)) max = r.updated_at;
        const b = meta.base[r.id], d = meta.dirty[r.id];
        if (b && b.rev >= r.rev) continue;
        const i = accepted.findIndex(x => x.id === r.id); if (i >= 0) accepted.splice(i, 1);
        if (r.kind === 'struct') { accepted.push(r); continue; } // Struktur wird immer zusammengeführt
        if (d && d.h !== 'gone' && r.status === 'live' && r.body?.page) {
          // Echter Konflikt: Seite wurde hier UND auf einem anderen Gerät geändert → beide Versionen behalten
          const loc = findPage(r.id);
          if (loc && contentKey(loc.page) !== contentKey(r.body.page)) {
            if (d.rev > r.rev) { copies.push({ src: r.body.page, after: r.id }); meta.base[r.id] = { h: '-', rev: r.rev, status: r.status, kind: r.kind }; continue; }
            copies.push({ src: JSON.parse(JSON.stringify(loc.page)), after: r.id });
          }
        } else if (d && d.rev > r.rev) { meta.base[r.id] = { h: '-', rev: r.rev, status: r.status, kind: r.kind }; continue; }
        if (first && r.kind === 'page' && r.status === 'live') { const loc = findPage(r.id); if (loc && loc.page.updated > (r.body?.page?.updated || 0)) continue; }
        accepted.push(r);
      }
      if (rows.length < PAGE_SIZE) break;
      since = rows[rows.length - 1].updated_at;
    }
    meta.cursor = max;
    if (!accepted.length && !copies.length) return false;

    const curId = state.ui.page, st = accepted.find(r => r.kind === 'struct');
    let target = null;
    if (st?.body) {
      const remote = structOf(st.body.notebooks || []);
      target = { notebooks: meta.dirty.struct && meta.baseStruct ? mergeStruct(meta.baseStruct, structOf(state.notebooks), remote) : remote };
      applyStruct(target, union);
    }
    for (const r of accepted) if (r.kind === 'page') applyPage(r);
    if (target) applyStruct(target, union); // zweiter Durchlauf: jetzt sind alle neuen Seiten da → richtige Reihenfolge
    for (const c of copies) {
      const p = mkLocalPage(c.src); p.id = uid(); p.title = (p.title || 'Unbenannte Seite') + ' (Konflikt)'; p.updated = Date.now();
      const loc = findPage(c.after), sec = loc ? loc.sec : state.notebooks[0].sections[0];
      sec.pages.splice(loc ? sec.pages.indexOf(loc.page) + 1 : sec.pages.length, 0, p);
      toast(`Bearbeitungskonflikt bei „${c.src.title || 'Unbenannte Seite'}“ – beide Versionen wurden behalten.`);
    }
    const rows = localRows();
    for (const r of accepted) {
      const h = r.kind === 'struct' ? fnv(JSON.stringify({ notebooks: structOf(r.body?.notebooks || []) })) : r.status === 'gone' ? 'gone' : (rows.get(r.id)?.h || '-');
      meta.base[r.id] = { h, rev: r.rev, status: r.status, kind: r.kind }; delete meta.dirty[r.id];
      if (r.kind === 'struct') meta.baseStruct = structOf(r.body?.notebooks || []);
    }
    await DB.set('state', state);
    if (accepted.some(r => r.id === curId) || !findPage(curId)) render(); else renderNav();
    return true;
  }
  const contentKey = p => JSON.stringify([p.title || '', p.blocks || [], p.strokes || [], p.paper || '', p.lvl || 0]);
  // Drei-Wege-Abgleich der Struktur: Lokale Änderungen (gegenüber dem letzten gemeinsamen Stand) gewinnen pro Feld,
  // neue Notizbücher/Abschnitte beider Seiten bleiben erhalten, Löschungen werden übernommen.
  function mergeStruct(base, local, remote) {
    const byId = a => new Map((a || []).map(x => [x.id, x]));
    const pick = (b, l, r, k) => (b && l && l[k] !== b[k]) ? l[k] : r[k];
    const merge = (bA, lA, rA, child) => {
      const B = byId(bA), L = byId(lA), R = byId(rA), out = [];
      for (const r of rA || []) { const l = L.get(r.id), b = B.get(r.id); if (b && !l) continue; out.push(child(b, l, r)); }
      for (const l of lA || []) if (!R.has(l.id) && !B.has(l.id)) out.push(child(undefined, l, l));
      return out;
    };
    return merge(base, local, remote, (b, l, r) => ({
      id: r.id, name: pick(b, l, r, 'name'), color: pick(b, l, r, 'color'),
      sections: merge(b?.sections, l?.sections, r.sections, (bs, ls, rs) => ({ id: rs.id, name: pick(bs, ls, rs, 'name'), color: pick(bs, ls, rs, 'color'), pages: rs.pages }))
    }));
  }

  // ---------- lokal → Remote ----------
  async function push() {
    const rows = scan(), ids = Object.keys(meta.dirty); if (!ids.length) return false;
    const items = ids.map(id => {
      const d = meta.dirty[id], r = rows.get(id);
      return d.h === 'gone' || !r
        ? { id, kind: meta.base[id]?.kind || 'page', status: 'gone', body: null, rev: d.rev, h: 'gone' }
        : { id, kind: r.kind, status: r.status, body: r.body(), rev: d.rev, h: d.h };
    });
    const chunks = []; let cur = [], size = 0;
    for (const it of items) {
      const s = JSON.stringify(it.body)?.length || 4;
      if (cur.length && size + s > CHUNK) { chunks.push(cur); cur = []; size = 0; }
      cur.push(it); size += s;
    }
    if (cur.length) chunks.push(cur);
    let rejected = false;
    for (const ch of chunks) {
      const ok = new Set((await call('/rest/v1/rpc/nw_push', { method: 'POST', body: { items: ch.map(({ h, ...x }) => x) } }) || []).map(x => x.id));
      for (const it of ch) {
        if (!ok.has(it.id)) { rejected = true; continue; }
        meta.base[it.id] = { h: it.h, rev: it.rev, status: it.status, kind: it.kind };
        if (it.kind === 'struct') meta.baseStruct = it.body.notebooks;
        if (meta.dirty[it.id]?.h === it.h) delete meta.dirty[it.id];
      }
      await saveMeta();
    }
    return rejected;
  }

  // ---------- Erster Abgleich auf einem Gerät ----------
  const isPristine = () => {
    const ps = [...allPages()];
    return !state.trash.length && ps.length === 1 && ps[0].page.title === 'Willkommen bei Notizwerk' && ps[0].page.updated === ps[0].page.created;
  };
  function choose() {
    return new Promise(res => {
      let done = false; const fin = v => { if (done) return; done = true; res(v); closeOverlay(); };
      const f = h(`<div class="modal"><h3>Notizen in der Cloud gefunden</h3>
        <p>Auf diesem Gerät gibt es schon eigene Notizen. Wie sollen sie mit der Cloud zusammenkommen?</p>
        <div class="row" style="flex-wrap:wrap"><button class="ghost" data-v="">Abbrechen</button><button class="ghost" data-v="cloud">Nur Cloud verwenden</button><button class="primary" data-v="merge">Zusammenführen</button></div>
        <p style="font-size:12px">„Nur Cloud verwenden“ speichert vorher ein Backup dieses Geräts als Datei.</p></div>`);
      f.onclick = e => { const b = e.target.closest('[data-v]'); if (b) fin(b.dataset.v || null); };
      openOverlay(f, () => fin(null));
    });
  }
  async function firstSync() {
    const any = await call('/rest/v1/nw_items?select=id&limit=1');
    meta.base = {}; meta.baseStruct = null; meta.dirty = {}; meta.cursor = null;
    if (any.length) {
      let mode = isPristine() ? 'cloud' : await choose();
      if (!mode) { setStatus('wait'); return false; }
      if (mode === 'cloud') {
        if (!isPristine()) download(`notizwerk-geraet-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state), 'application/json');
        state.notebooks = []; state.trash = [];
      }
      await pull({ first: true, union: mode === 'merge' });
      if (!state.notebooks.length) state.notebooks.push(mkNotebook('Mein Notizbuch'));
    }
    meta.synced = true; await saveMeta();
    await push(); render(); await DB.set('state', state);
    return true;
  }

  // ---------- Ablauf ----------
  async function cycle() {
    if (!configured() || !loggedIn()) return setStatus(configured() ? 'login' : 'off');
    if (!navigator.onLine) return setStatus('offline');
    setStatus('busy');
    try {
      if (!meta.synced) { if (!await firstSync()) return; }
      else { await pull(); if (await push()) await pull(); }
      meta.last = Date.now(); await saveMeta(); setStatus('ok');
    } catch (e) {
      console.warn('Sync:', e);
      if (e instanceof AuthError) { setStatus('login'); toast('Bitte erneut anmelden, um zu synchronisieren.'); }
      else if (e instanceof TypeError) setStatus('offline');
      else { setStatus('error', e.message); }
    }
  }
  function sync() {
    if (running) { again = true; return running; }
    running = (async () => { do { again = false; await cycle(); } while (again); })().finally(() => { running = null; });
    return running;
  }
  function changed() { if (!loggedIn() || !meta.synced) return; clearTimeout(pushT); pushT = setTimeout(sync, 1500); }

  // ---------- Anzeige & Anmeldung ----------
  const LABEL = { off: '☁ Sync einrichten', login: '☁ Anmelden', busy: '☁ Synchronisiert …', ok: '☁ Synchron', offline: '☁ Offline', error: '⚠ Sync-Fehler', wait: '☁ Abgleich offen' };
  let statusMsg = '';
  function setStatus(s, msg = '') {
    status = s; statusMsg = msg; const b = $('#syncBtn'); if (!b) return;
    b.textContent = LABEL[s] || s;
    b.title = s === 'ok' && meta.last ? 'Zuletzt abgeglichen: ' + fmtDate(meta.last) : (msg || 'Synchronisation');
  }
  function dialog() {
    const c = conf(), box = h('<form class="modal" autocomplete="on"></form>');
    const show = (html, onSubmit) => { box.innerHTML = html; box.onsubmit = e => { e.preventDefault(); onSubmit(); }; };
    const err = t => { const p = $('.err', box); if (p) p.textContent = t; };
    const busy = (on) => $$('button', box).forEach(b => b.disabled = on);
    const nice = e => /invalid login|invalid_credentials|invalid_grant/i.test(e.message + e.code) ? 'E-Mail oder Passwort falsch.'
      : /not confirmed/i.test(e.message) ? 'Bitte zuerst den Link in der Bestätigungs-E-Mail anklicken.'
      : /already registered|already exists/i.test(e.message) ? 'Diese E-Mail ist schon registriert – bitte anmelden.'
      : /signups? not allowed|signup_disabled/i.test(e.message + e.code) ? 'Neue Konten sind abgeschaltet. Bitte mit deinem bestehenden Konto anmelden.'
      : /password/i.test(e.message) ? 'Das Passwort muss mindestens 6 Zeichen haben.'
      : e instanceof TypeError ? 'Keine Verbindung zum Server. Stimmt die Projekt-URL?' : e.message;

    if (!configured()) {
      show(`<h3>Synchronisation einrichten</h3><p>Trage die Daten aus deinem Supabase-Projekt ein (Project Settings → API).</p>
        <input name="url" placeholder="Project URL, z. B. https://abcd.supabase.co" value="${esc(c.url)}" required>
        <input name="key" placeholder="Publishable key (sb_publishable_…) oder anon key" value="${esc(c.key)}" required>
        <p class="err" style="color:var(--danger)"></p><div class="row"><button type="button" class="ghost" data-x>Abbrechen</button><button class="primary">Weiter</button></div>`, () => {
        const url = box.url.value.trim(), key = box.key.value.trim();
        if (!/^https?:\/\/[^/]+/.test(url)) return err('Die URL muss mit https:// beginnen.');
        localStorage.setItem('nw:supabase', JSON.stringify({ url, key })); keepalive(true); dialog();
      });
    } else if (!loggedIn()) {
      show(`<h3>Bei Notizwerk-Sync anmelden</h3><p>Mit demselben Konto auf iPhone, iPad und Mac anmelden – dann sind überall dieselben Notizen.</p>
        <input name="email" type="email" placeholder="E-Mail" autocomplete="username" value="${esc(meta.session?.email || '')}" required>
        <input name="pw" type="password" placeholder="Passwort (mind. 6 Zeichen)" autocomplete="current-password" required minlength="6">
        <p class="err" style="color:var(--danger)"></p>
        <div class="row" style="flex-wrap:wrap"><button type="button" class="ghost" data-reset style="margin-right:auto">Server ändern</button><button type="button" class="ghost" data-signup>Konto erstellen</button><button class="primary">Anmelden</button></div>`, async () => {
        busy(true); err('');
        try { setSession(await authCall('token?grant_type=password', { email: box.email.value.trim(), password: box.pw.value })); meta.synced = false; await saveMeta(); closeOverlay(); toast('Angemeldet – Notizen werden abgeglichen'); sync(); }
        catch (e) { err(nice(e)); busy(false); }
      });
      $('[data-signup]', box).onclick = async () => {
        if (!box.reportValidity()) return; busy(true); err('');
        try {
          const j = await authCall('signup', { email: box.email.value.trim(), password: box.pw.value });
          if (j?.access_token) { setSession(j); meta.synced = false; await saveMeta(); closeOverlay(); toast('Konto erstellt – Notizen werden hochgeladen'); sync(); }
          else { err(''); $('.err', box).style.color = 'var(--acc)'; $('.err', box).textContent = 'Fast geschafft: Bestätige die E-Mail, die Supabase dir geschickt hat, und melde dich dann hier an.'; busy(false); }
        } catch (e) { err(nice(e)); busy(false); }
      };
      $('[data-reset]', box).onclick = () => { localStorage.removeItem('nw:supabase'); dialog(); };
    } else {
      show(`<h3>Synchronisation</h3><p>Angemeldet als <b>${esc(meta.session.email)}</b>.<br>
        Status: ${esc(LABEL[status] || status)}${statusMsg ? ' – ' + esc(statusMsg) : ''}${meta.last ? '<br>Zuletzt abgeglichen: ' + fmtDate(meta.last) : ''}</p>
        <p style="font-size:12px">Änderungen werden automatisch hochgeladen; andere Geräte holen sie beim Öffnen und alle 30 Sekunden ab.</p>
        <div class="row" style="flex-wrap:wrap"><button type="button" class="ghost" data-out style="margin-right:auto">Abmelden</button><button type="button" class="ghost" data-x>Schließen</button><button class="primary">Jetzt abgleichen</button></div>`, () => { closeOverlay(); sync(); });
      $('[data-out]', box).onclick = async () => {
        try { await call('/auth/v1/logout', { method: 'POST' }); } catch { }
        meta = { session: { email: meta.session.email }, cursor: null, base: {}, baseStruct: null, dirty: {}, synced: false, last: 0 };
        meta.session.refresh = null; await saveMeta(); closeOverlay(); setStatus('login'); toast('Abgemeldet – die Notizen bleiben auf diesem Gerät.');
      };
    }
    box.addEventListener('click', e => { if (e.target.closest('[data-x]')) closeOverlay(); });
    openOverlay(box); $('input', box)?.focus();
  }

  // Keep-alive: einmal täglich pro Gerät eine kleine Anfrage, damit Supabase das Projekt nicht pausiert.
  function keepalive(force) {
    if (!configured()) return;
    const day = new Date().toISOString().slice(0, 10);
    if (!force && localStorage.getItem('nw:keepalive') === day) return;
    call('/rest/v1/rpc/nw_keepalive', { method: 'POST', body: {}, auth: false }).then(() => localStorage.setItem('nw:keepalive', day)).catch(() => { });
  }

  async function start() {
    const m = await DB.get('sync'); if (m) meta = Object.assign(meta, m);
    setStatus(!configured() ? 'off' : loggedIn() ? 'busy' : 'login');
    keepalive(); sync();
    setInterval(() => { if (!document.hidden) { sync(); keepalive(); } }, POLL);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
    addEventListener('online', () => sync());
    addEventListener('offline', () => setStatus('offline'));
  }
  return { start, sync, changed, dialog, get status() { return status; } };
})();
