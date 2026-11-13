'use strict';
/* Notizwerk – freies Notizbuch im Browser. Alles bleibt lokal (IndexedDB). */

// ---------- Helfer ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const h = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const exec = (c, v = null) => document.execCommand(c, false, v);
const fmtDate = t => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const COLORS = ['#3b5bdb', '#0c8599', '#2b9a66', '#e8890c', '#e5484d', '#c2298a', '#8e4ec6', '#6b7280'];
const INK = ['auto', '#e5484d', '#3b5bdb', '#2b9a66', '#f5a524', '#8e4ec6'];
const TEXTCOLORS = ['#e5484d', '#e8890c', '#2b9a66', '#0c8599', '#3b5bdb', '#8e4ec6', '#c2298a', '#6b7280'];
const HILITES = ['rgba(255,212,0,.45)', 'rgba(90,220,130,.4)', 'rgba(110,180,255,.45)', 'rgba(255,140,170,.45)', 'rgba(200,150,255,.45)'];
const TAGS = { wichtig: '★ Wichtig', frage: '? Frage', merke: '✎ Merke', pruefung: '◎ Prüfungsrelevant' };
const parser = new DOMParser();

const canvas = $('#canvas'), ink = $('#ink'), titleEl = $('#title'), overlay = $('#overlay'), scroller = $('#scroller');
let state, mode = 'text', study = false;

// ---------- Speicher ----------
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('notizwerk', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(this.db = r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    try {
      const db = await this.open();
      return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    } catch { const s = localStorage.getItem('notizwerk:' + k); return s ? JSON.parse(s) : undefined; }
  },
  async set(k, v) {
    try {
      const db = await this.open();
      return await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch { localStorage.setItem('notizwerk:' + k, JSON.stringify(v)); }
  }
};
let saveT = null;
function save() { $('#saveState').textContent = 'Speichert …'; clearTimeout(saveT); saveT = setTimeout(flush, 400); }
async function flush() {
  clearTimeout(saveT); saveT = null;
  try { await DB.set('state', state); $('#saveState').textContent = 'Gespeichert'; if (typeof Sync !== 'undefined') Sync.changed(); }
  catch (e) { console.error(e); $('#saveState').textContent = 'Speichern fehlgeschlagen!'; }
}

// ---------- Datenmodell ----------
function mkPage(title = '', extra = {}) { const t = Date.now(); return { id: uid(), title, lvl: 0, paper: 'blank', created: t, updated: t, blocks: [], strokes: [], ...extra }; }
function mkSection(name, color) { return { id: uid(), name, color: color || COLORS[0], pages: [mkPage('')] }; }
function mkNotebook(name, color) { return { id: uid(), name, color: color || COLORS[0], sections: [mkSection('Allgemein', color)] }; }
function seed() {
  const nb = mkNotebook('Mein Notizbuch', COLORS[0]);
  const sec = nb.sections[0]; sec.name = 'Start';
  const p = sec.pages[0]; p.title = 'Willkommen bei Notizwerk';
  p.blocks = [
    { id: uid(), x: 48, y: 30, w: 520, html:
      '<h2>So funktioniert es</h2>' +
      '<div>Klicke <b>irgendwo</b> auf die Seite und schreibe los. Jeder Textkasten lässt sich am grauen Balken oben verschieben und am rechten Rand breiter ziehen.</div><div><br></div>' +
      '<ul><li>Links: <b>Notizbuch → Abschnitte → Seiten</b> (Rechtsklick für Optionen, Ziehen zum Sortieren)</li>' +
      '<li><b>Stift</b>, <b>Marker</b> und <b>Radierer</b> zum Zeichnen über allem</li>' +
      '<li>Bilder einfach hineinziehen oder einfügen</li>' +
      '<li><b>⌘K / Strg+K</b> durchsucht alle Notizen sofort</li>' +
      '<li>Tippe <b>[[Seitentitel]]</b>, um Seiten zu verknüpfen</li></ul>' +
      '<h3>Schneller tippen</h3>' +
      '<div><b>#</b>, <b>##</b>, <b>###</b> + Leertaste → Überschrift · <b>-</b> → Liste · <b>1.</b> → Nummerierung · <b>[]</b> → Aufgabe · <b>&gt;</b> → Zitat</div>' },
    { id: uid(), x: 620, y: 30, w: 380, html:
      '<h2>Lernmodus</h2>' +
      '<div>Markiere Text und klicke <b>Lücke</b>. Mit <b>Abfragen</b> werden alle Lücken verdeckt – ein Klick deckt sie auf.</div><div><br></div>' +
      '<div data-tag="merke">Die ATP-Synthase sitzt in der <span class="cloze">inneren Mitochondrienmembran</span>.</div><div><br></div>' +
      '<ul class="todo"><li class="done">Notizwerk öffnen</li><li>Erste eigene Seite anlegen</li><li>Lernmodus ausprobieren</li></ul>' }
  ];
  return { v: 1, notebooks: [nb], trash: [], ui: { nb: nb.id, sec: sec.id, page: p.id, theme: 'auto', pen: { color: 'auto', width: 2.5 } } };
}
function normalise(s) {
  if (!s || !Array.isArray(s.notebooks)) return seed();
  s.trash = Array.isArray(s.trash) ? s.trash : [];
  s.ui = Object.assign({ theme: 'auto', pen: { color: 'auto', width: 2.5 } }, s.ui || {});
  if (!s.notebooks.length) s.notebooks.push(mkNotebook('Mein Notizbuch'));
  for (const nb of s.notebooks) {
    nb.id = nb.id || uid(); nb.name = nb.name || 'Notizbuch'; nb.color = nb.color || COLORS[0];
    if (!Array.isArray(nb.sections) || !nb.sections.length) nb.sections = [mkSection('Allgemein', nb.color)];
    for (const sec of nb.sections) {
      sec.id = sec.id || uid(); sec.name = sec.name || 'Abschnitt'; sec.color = sec.color || COLORS[0];
      if (!Array.isArray(sec.pages) || !sec.pages.length) sec.pages = [mkPage('')];
      sec.pages = sec.pages.map(p => Object.assign(mkPage(''), p, { blocks: Array.isArray(p.blocks) ? p.blocks : [], strokes: Array.isArray(p.strokes) ? p.strokes : [] }));
    }
  }
  return s;
}
const nbOf = () => state.notebooks.find(n => n.id === state.ui.nb) || state.notebooks[0];
const secOf = () => { const n = nbOf(); return n.sections.find(s => s.id === state.ui.sec) || n.sections.find(s => s.id === n.last) || n.sections[0]; };
const pageOf = () => { const s = secOf(); return s.pages.find(p => p.id === state.ui.page) || s.pages.find(p => p.id === s.last) || s.pages[0]; };
function* allPages() { for (const nb of state.notebooks) for (const sec of nb.sections) for (const page of sec.pages) yield { nb, sec, page }; }
const findPage = id => { for (const x of allPages()) if (x.page.id === id) return x; return null; };
function go(pageId) {
  const x = findPage(pageId); if (!x) return;
  state.ui.nb = x.nb.id; state.ui.sec = x.sec.id; state.ui.page = pageId; x.sec.last = pageId; x.nb.last = x.sec.id;
  render(); save();
}
function addPage(title = '', sec = secOf(), afterId = null, lvl = 0) {
  const p = mkPage(title, { lvl });
  const i = afterId ? sec.pages.findIndex(q => q.id === afterId) : -1;
  if (i >= 0) sec.pages.splice(i + 1, 0, p); else sec.pages.push(p);
  return p;
}
let navT = null;
function touch(p) { p.updated = Date.now(); renderMeta(); save(); clearTimeout(navT); navT = setTimeout(renderNav, 500); }

// ---------- HTML säubern ----------
const OK_TAGS = new Set('DIV P BR SPAN B STRONG I EM U S STRIKE H1 H2 H3 UL OL LI BLOCKQUOTE PRE CODE A IMG TABLE TBODY THEAD TR TD TH HR SUB SUP'.split(' '));
const DROP_TAGS = /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|META|LINK|TITLE|HEAD|SVG|MATH|FORM|INPUT|BUTTON|TEXTAREA|SELECT|NOSCRIPT|TEMPLATE|VIDEO|AUDIO)$/;
const OK_CLASS = new Set(['cloze', 'todo', 'done', 'plink']);
const cleanStyle = s => s.split(';').map(x => x.trim()).filter(x => /^(color|background-color|font-weight|font-style|text-decoration(-line)?|text-align)\s*:/i.test(x) && !/url|expression|javascript/i.test(x)).join(';');
function sanitize(html, pasted = false) {
  const doc = parser.parseFromString('<body>' + html, 'text/html');
  const walk = n => {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === 3) continue;
      if (c.nodeType !== 1) { c.remove(); continue; }
      const tag = c.tagName.toUpperCase();
      if (DROP_TAGS.test(tag)) { c.remove(); continue; }
      walk(c);
      if (!OK_TAGS.has(tag)) { c.replaceWith(...c.childNodes); continue; }
      for (const a of [...c.attributes]) {
        const n2 = a.name.toLowerCase(), v = a.value;
        let keep = false;
        if (n2 === 'href') keep = /^(https?:|mailto:)/i.test(v.trim());
        else if (n2 === 'src') keep = /^(data:image\/(png|jpe?g|gif|webp);base64,|https?:)/i.test(v.trim());
        else if (n2 === 'colspan' || n2 === 'rowspan') keep = /^\d+$/.test(v);
        else if (pasted) keep = false;
        else if (n2 === 'class') { const k = v.split(/\s+/).filter(x => OK_CLASS.has(x)).join(' '); if (k) { c.setAttribute('class', k); keep = true; } }
        else if (n2 === 'data-page') keep = /^[a-z0-9]+$/i.test(v);
        else if (n2 === 'data-tag') keep = v in TAGS;
        else if (n2 === 'style') { const k = cleanStyle(v); if (k) { c.setAttribute('style', k); keep = true; } }
        if (!keep) c.removeAttribute(a.name);
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
const htmlEmpty = html => !/<(img|table|hr)\b/i.test(html) && !html.replace(/<[^>]+>/g, '').replace(/&nbsp;|\s/g, '');
const textCache = new WeakMap();
function pageText(p) {
  const c = textCache.get(p); if (c && c.u === p.updated) return c.t;
  const t = p.blocks.map(b => parser.parseFromString(b.html.replace(/<(div|br|li|p|h\d|td|tr|blockquote|pre)\b/gi, ' <$1'), 'text/html').body.textContent).join(' ').replace(/\s+/g, ' ').trim();
  textCache.set(p, { u: p.updated, t }); return t;
}

// ---------- Overlay, Menü, Toast ----------
let overlayClose = null;
function openOverlay(node, onClose) { closeOverlay(); overlay.append(node); overlay.classList.add('open'); overlayClose = onClose || null; }
function closeOverlay() {
  if (!overlay.classList.contains('open')) return;
  overlay.classList.remove('open'); overlay.innerHTML = '';
  const f = overlayClose; overlayClose = null; f && f();
}
overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeOverlay(); });
function ask(label, value = '', okLabel = 'OK') {
  return new Promise(res => {
    let done = false; const fin = v => { if (done) return; done = true; res(v); closeOverlay(); };
    const f = h(`<form class="modal"><h3>${esc(label)}</h3><input><div class="row"><button type="button" class="ghost">Abbrechen</button><button class="primary">${esc(okLabel)}</button></div></form>`);
    const inp = $('input', f); inp.value = value;
    f.onsubmit = e => { e.preventDefault(); fin(inp.value.trim()); };
    $('.ghost', f).onclick = () => fin(null);
    openOverlay(f, () => fin(null)); inp.focus(); inp.select();
  });
}
function confirmBox(title, text, okLabel = 'Löschen') {
  return new Promise(res => {
    let done = false; const fin = v => { if (done) return; done = true; res(v); closeOverlay(); };
    const f = h(`<div class="modal"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="row"><button class="ghost">Abbrechen</button><button class="primary danger">${esc(okLabel)}</button></div></div>`);
    $('.ghost', f).onclick = () => fin(false); $('.primary', f).onclick = () => fin(true);
    openOverlay(f, () => fin(false)); $('.primary', f).focus();
  });
}
let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; }
function menu(anchor, items) {
  closeMenu();
  const m = menuEl = document.createElement('div'); m.className = 'menu';
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(document.createElement('hr')); continue; }
    if (it.head) { m.append(h(`<div class="head">${esc(it.head)}</div>`)); continue; }
    if (it.swatches) {
      const row = h('<div class="swatches"></div>');
      for (const c of it.swatches) { const b = document.createElement('button'); b.style.background = c === 'auto' ? 'var(--fg)' : c; b.onclick = () => { closeMenu(); it.fn(c); }; row.append(b); }
      m.append(row); continue;
    }
    const b = document.createElement('button'); b.className = 'mi' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''); b.textContent = it.label;
    b.onclick = () => { closeMenu(); it.fn(); }; m.append(b);
  }
  m.onmousedown = e => e.preventDefault();
  m.oncontextmenu = e => e.preventDefault();
  document.body.append(m);
  let x, y;
  if (anchor instanceof Element) { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 4; } else ({ x, y } = anchor);
  m.style.left = Math.max(6, Math.min(x, innerWidth - m.offsetWidth - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, innerHeight - m.offsetHeight - 6)) + 'px';
}
document.addEventListener('mousedown', e => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
function toast(msg, actionLabel, fn) {
  const t = h(`<div class="toast"><span>${esc(msg)}</span></div>`);
  if (actionLabel) { const b = document.createElement('button'); b.textContent = actionLabel; b.onclick = () => { t.remove(); fn(); }; t.append(b); }
  $('#toasts').append(t); setTimeout(() => t.remove(), actionLabel ? 7000 : 3000);
}
function download(name, text, type = 'text/plain') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Navigation ----------
function ensure() {
  if (!state.notebooks.length) state.notebooks.push(mkNotebook('Mein Notizbuch'));
  const n = nbOf(); if (!n.sections.length) n.sections.push(mkSection('Allgemein', n.color));
  const s = secOf(); if (!s.pages.length) s.pages.push(mkPage(''));
}
function renderNav() {
  ensure();
  const nb = nbOf(), sec = secOf(), page = pageOf();
  $('#nbBtn').innerHTML = `<span class="dot" style="background:${esc(nb.color)}"></span><b>${esc(nb.name)}</b><span>▾</span>`;
  $('#sections').innerHTML = nb.sections.map(s => `<div class="sec${s.id === sec.id ? ' on' : ''}" draggable="true" data-id="${s.id}" style="--c:${esc(s.color)}" title="${esc(s.name)}">${esc(s.name)}</div>`).join('');
  $('#pages').innerHTML = sec.pages.map(p => {
    const prev = pageText(p).slice(0, 70);
    return `<div class="pg lvl${p.lvl || 0}${p.id === page.id ? ' on' : ''}" draggable="true" data-id="${p.id}" style="--c:${esc(sec.color)}"><span class="t${p.title ? '' : ' empty'}">${esc(p.title || 'Unbenannte Seite')}</span><small>${esc(prev) || '&nbsp;'}</small></div>`;
  }).join('');
}
function selectSection(id) {
  const nb = nbOf(), s = nb.sections.find(x => x.id === id); if (!s) return;
  state.ui.sec = id; nb.last = id; state.ui.page = (s.pages.find(p => p.id === s.last) || s.pages[0]).id; render(); save();
}
function selectNotebook(id) {
  const nb = state.notebooks.find(n => n.id === id); if (!nb) return;
  state.ui.nb = id; const s = nb.sections.find(x => x.id === nb.last) || nb.sections[0];
  state.ui.sec = s.id; state.ui.page = (s.pages.find(p => p.id === s.last) || s.pages[0]).id; render(); save();
}
function newPage(afterId = null, lvl = 0) { const p = addPage('', secOf(), afterId, lvl); go(p.id); titleEl.focus(); }
const pageBlank = p => !p.title && !p.strokes.length && p.blocks.every(b => htmlEmpty(b.html));
function trashPage(sec, nb, page) { if (!pageBlank(page)) state.trash.unshift({ page, secId: sec.id, where: `${nb.name} › ${sec.name}`, at: Date.now() }); }
function deletePage(id) {
  const x = findPage(id); if (!x) return;
  const i = x.sec.pages.indexOf(x.page); x.sec.pages.splice(i, 1);
  const blank = pageBlank(x.page); trashPage(x.sec, x.nb, x.page);
  if (!x.sec.pages.length) x.sec.pages.push(mkPage(''));
  if (state.ui.page === id) state.ui.page = x.sec.pages[Math.max(0, i - 1)].id;
  render(); save();
  if (!blank) toast('Seite in den Papierkorb verschoben', 'Rückgängig', () => restoreTrash(x.page.id));
}
function restoreTrash(pageId) {
  const i = state.trash.findIndex(t => t.page.id === pageId); if (i < 0) return;
  const t = state.trash.splice(i, 1)[0];
  let sec = secOf(); for (const nb of state.notebooks) for (const s of nb.sections) if (s.id === t.secId) sec = s;
  sec.pages.push(t.page); go(t.page.id);
}
function duplicatePage(id) {
  const x = findPage(id); if (!x) return;
  const c = JSON.parse(JSON.stringify(x.page)); c.id = uid(); c.title = (c.title || 'Unbenannte Seite') + ' (Kopie)'; c.created = c.updated = Date.now(); c.blocks.forEach(b => b.id = uid());
  x.sec.pages.splice(x.sec.pages.indexOf(x.page) + 1, 0, c); go(c.id);
}
function movePage(id, secId) {
  const x = findPage(id); if (!x || x.sec.id === secId) return;
  let target; for (const nb of state.notebooks) for (const s of nb.sections) if (s.id === secId) target = s;
  if (!target) return;
  const wasCurrent = state.ui.page === id;
  x.sec.pages.splice(x.sec.pages.indexOf(x.page), 1); if (!x.sec.pages.length) x.sec.pages.push(mkPage(''));
  x.page.lvl = 0; target.pages.push(x.page);
  if (wasCurrent) go(id); else { render(); save(); }
  toast(`Verschoben nach „${target.name}“`);
}
async function deleteSection(id) {
  const nb = nbOf(), s = nb.sections.find(x => x.id === id); if (!s) return;
  if (!await confirmBox(`Abschnitt „${s.name}“ löschen?`, 'Die Seiten landen im Papierkorb und lassen sich wiederherstellen.')) return;
  s.pages.forEach(p => trashPage(s, nb, p));
  nb.sections.splice(nb.sections.indexOf(s), 1); if (!nb.sections.length) nb.sections.push(mkSection('Allgemein', nb.color));
  selectSection(nb.sections[0].id);
}
async function deleteNotebook() {
  const nb = nbOf();
  if (!await confirmBox(`Notizbuch „${nb.name}“ löschen?`, 'Alle Seiten landen im Papierkorb und lassen sich wiederherstellen.')) return;
  for (const s of nb.sections) s.pages.forEach(p => trashPage(s, nb, p));
  state.notebooks.splice(state.notebooks.indexOf(nb), 1); if (!state.notebooks.length) state.notebooks.push(mkNotebook('Mein Notizbuch'));
  selectNotebook(state.notebooks[0].id);
}
$('#nbBtn').onclick = e => {
  const nb = nbOf();
  menu(e.currentTarget, [
    { head: 'Notizbücher' },
    ...state.notebooks.map(n => ({ label: n.name, checked: n.id === nb.id, fn: () => selectNotebook(n.id) })),
    '-',
    { label: '+ Neues Notizbuch', fn: async () => { const name = await ask('Name des Notizbuchs', '', 'Anlegen'); if (!name) return; const n = mkNotebook(name, COLORS[state.notebooks.length % COLORS.length]); state.notebooks.push(n); selectNotebook(n.id); } },
    { label: 'Umbenennen', fn: async () => { const name = await ask('Notizbuch umbenennen', nb.name); if (name) { nb.name = name; renderNav(); save(); } } },
    { swatches: COLORS, fn: c => { nb.color = c; renderNav(); save(); } },
    { label: 'Notizbuch löschen', danger: true, fn: deleteNotebook }
  ]);
};
$('#addSec').onclick = async () => {
  const name = await ask('Name des Abschnitts', '', 'Anlegen'); if (!name) return;
  const nb = nbOf(), s = mkSection(name, COLORS[nb.sections.length % COLORS.length]); nb.sections.push(s); selectSection(s.id); titleEl.focus();
};
$('#addPage').onclick = () => newPage();
async function renameSection(id) { const s = nbOf().sections.find(x => x.id === id); const name = await ask('Abschnitt umbenennen', s.name); if (name) { s.name = name; renderNav(); save(); } }
$('#sections').addEventListener('click', e => { const it = e.target.closest('.sec'); if (it) selectSection(it.dataset.id); });
$('#sections').addEventListener('dblclick', e => { const it = e.target.closest('.sec'); if (it) renameSection(it.dataset.id); });
$('#sections').addEventListener('contextmenu', e => {
  const it = e.target.closest('.sec'); if (!it) return; e.preventDefault(); const id = it.dataset.id;
  menu({ x: e.clientX, y: e.clientY }, [
    { label: 'Umbenennen', fn: () => renameSection(id) },
    { swatches: COLORS, fn: c => { nbOf().sections.find(x => x.id === id).color = c; renderNav(); save(); } },
    { label: 'Abschnitt löschen', danger: true, fn: () => deleteSection(id) }
  ]);
});
$('#pages').addEventListener('click', e => { const it = e.target.closest('.pg'); if (it && it.dataset.id !== state.ui.page) go(it.dataset.id); if (it && innerWidth <= 820) document.body.classList.add('nonav'); });
$('#pages').addEventListener('contextmenu', e => {
  const it = e.target.closest('.pg'); if (!it) return; e.preventDefault(); const id = it.dataset.id, x = findPage(id);
  const setLvl = d => { x.page.lvl = Math.max(0, Math.min(2, (x.page.lvl || 0) + d)); renderNav(); save(); };
  menu({ x: e.clientX, y: e.clientY }, [
    { label: 'Neue Seite darunter', fn: () => newPage(id, x.page.lvl || 0) },
    { label: 'Neue Unterseite', fn: () => newPage(id, Math.min(2, (x.page.lvl || 0) + 1)) },
    '-',
    (x.page.lvl || 0) < 2 && { label: 'Zur Unterseite machen →', fn: () => setLvl(1) },
    (x.page.lvl || 0) > 0 && { label: '← Höher stufen', fn: () => setLvl(-1) },
    { label: 'Duplizieren', fn: () => duplicatePage(id) },
    { label: 'Verschieben nach …', fn: () => {
      const items = [{ head: 'Ziel-Abschnitt' }];
      for (const nb of state.notebooks) for (const s of nb.sections) if (s.id !== x.sec.id) items.push({ label: `${nb.name} › ${s.name}`, fn: () => movePage(id, s.id) });
      if (items.length === 1) return toast('Es gibt noch keinen anderen Abschnitt.');
      menu({ x: e.clientX, y: e.clientY }, items);
    } },
    '-',
    { label: 'Seite löschen', danger: true, fn: () => deletePage(id) }
  ]);
});
// Sortieren per Drag & Drop
let drag = null;
function dnd(list, type, getArr) {
  const clear = () => $$('.dropA,.dropB,.dropOn').forEach(e => e.classList.remove('dropA', 'dropB', 'dropOn'));
  list.addEventListener('dragstart', e => { const it = e.target.closest('[data-id]'); if (!it) return; drag = { type, id: it.dataset.id }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'notizwerk'); });
  list.addEventListener('dragover', e => {
    const it = e.target.closest('[data-id]'); if (!drag || !it) return;
    if (drag.type === type) { e.preventDefault(); clear(); const r = it.getBoundingClientRect(); it.classList.add(e.clientY < r.top + r.height / 2 ? 'dropB' : 'dropA'); }
    else if (type === 'sec' && drag.type === 'page') { e.preventDefault(); clear(); it.classList.add('dropOn'); }
  });
  list.addEventListener('dragleave', clear);
  list.addEventListener('drop', e => {
    const it = e.target.closest('[data-id]'); if (!drag || !it) return; e.preventDefault();
    const after = it.classList.contains('dropA'); clear();
    if (drag.type !== type) { movePage(drag.id, it.dataset.id); drag = null; return; }
    if (it.dataset.id === drag.id) return;
    const arr = getArr(), item = arr.splice(arr.findIndex(x => x.id === drag.id), 1)[0];
    arr.splice(arr.findIndex(x => x.id === it.dataset.id) + (after ? 1 : 0), 0, item);
    drag = null; renderNav(); save();
  });
  list.addEventListener('dragend', () => { drag = null; clear(); });
}
dnd($('#sections'), 'sec', () => nbOf().sections);
dnd($('#pages'), 'page', () => secOf().pages);

// ---------- Seite ----------
function blockEl(b) {
  const el = h('<div class="block"><div class="bh" title="Ziehen zum Verschieben">⋯<button class="bx" title="Kasten löschen">×</button></div><div class="bb" contenteditable="true" spellcheck="true"></div><div class="br" title="Breite ändern"></div></div>');
  el.dataset.id = b.id; el.style.left = b.x + 'px'; el.style.top = b.y + 'px'; el.style.width = b.w + 'px';
  $('.bb', el).innerHTML = b.html; return el;
}
const blockData = el => pageOf().blocks.find(b => b.id === el.dataset.id);
const isEmpty = bb => !bb.textContent.trim() && !bb.querySelector('img,table,hr');
function render() { renderNav(); renderPage(); }
function renderPage() {
  ensure(); const p = pageOf(); state.ui.page = p.id;
  p.blocks = p.blocks.filter(b => !htmlEmpty(b.html));
  titleEl.value = p.title; document.title = (p.title || 'Unbenannte Seite') + ' – Notizwerk';
  canvas.dataset.paper = p.paper || 'blank';
  $$('.block', canvas).forEach(e => e.remove());
  for (const b of p.blocks) canvas.append(blockEl(b));
  refreshLinks(); renderInk(); fitCanvas(); renderMeta(); renderBacklinks();
  canvas.classList.toggle('study', study); scroller.scrollTo(0, 0);
}
function renderMeta() {
  const p = pageOf(), t = pageText(p), words = t ? t.split(/\s+/).length : 0;
  const d = new Date(p.created);
  $('#meta').innerHTML = `<span>${d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span><span>${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span><span class="more">geändert ${fmtDate(p.updated)} · ${words} ${words === 1 ? 'Wort' : 'Wörter'}</span>`;
}
function refreshLinks() {
  for (const a of $$('a.plink', canvas)) { const x = findPage(a.dataset.page); a.classList.toggle('dead', !x); if (x && a.textContent !== (x.page.title || 'Unbenannte Seite')) a.textContent = x.page.title || 'Unbenannte Seite'; }
}
function renderBacklinks() {
  const p = pageOf(), needle = `data-page="${p.id}"`, hits = [];
  for (const x of allPages()) if (x.page !== p && x.page.blocks.some(b => b.html.includes(needle))) hits.push(x.page);
  $('#backlinks').innerHTML = hits.length ? 'Verweise auf diese Seite: ' + hits.map(q => `<a data-go="${q.id}">${esc(q.title || 'Unbenannte Seite')}</a>`).join('') : '';
}
$('#backlinks').addEventListener('click', e => { const a = e.target.closest('[data-go]'); if (a) go(a.dataset.go); });
function fitCanvas() {
  let w = 0, hh = 0;
  for (const el of $$('.block', canvas)) { w = Math.max(w, el.offsetLeft + el.offsetWidth); hh = Math.max(hh, el.offsetTop + el.offsetHeight); }
  for (const s of pageOf().strokes) for (let i = 0; i < s.p.length; i += 2) { if (s.p[i] > w) w = s.p[i]; if (s.p[i + 1] > hh) hh = s.p[i + 1]; }
  canvas.style.width = (w + 300) + 'px'; canvas.style.height = (hh + 500) + 'px';
}
titleEl.addEventListener('input', () => { const p = pageOf(); p.title = titleEl.value; document.title = (p.title || 'Unbenannte Seite') + ' – Notizwerk'; touch(p); });
titleEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return; e.preventDefault();
  const first = $('.block .bb', canvas); focusEnd(first || $('.bb', newBlock(48, 24)));
});
function focusEnd(bb) { bb.focus(); const r = document.createRange(); r.selectNodeContents(bb); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
function caretIn(node) { const r = document.createRange(); r.selectNodeContents(node); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
function newBlock(x, y, html = '<div><br></div>', w = 460) {
  const b = { id: uid(), x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), w, html };
  pageOf().blocks.push(b); const el = blockEl(b); canvas.append(el); return el;
}
function removeBlock(el, withUndo) {
  const p = pageOf(), i = p.blocks.findIndex(b => b.id === el.dataset.id); if (i < 0) return el.remove();
  const b = p.blocks.splice(i, 1)[0]; el.remove();
  if (withUndo) { touch(p); fitCanvas(); toast('Kasten gelöscht', 'Rückgängig', () => { if (pageOf() !== p) return; p.blocks.push(b); canvas.append(blockEl(b)); touch(p); fitCanvas(); }); }
}
function syncBlock(bb) {
  const el = bb.closest('.block'), b = el && blockData(el); if (!b) return;
  b.html = bb.innerHTML.replace(/cloze revealed/g, 'cloze'); touch(pageOf()); fitCanvas();
}
function activeBB() {
  const s = getSelection(); if (!s.rangeCount || !s.anchorNode) return null;
  const n = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement; return n?.closest('.bb') || null;
}
const selEl = () => { const n = getSelection().anchorNode; return n ? (n.nodeType === 1 ? n : n.parentElement) : null; };
const pt = e => { const r = canvas.getBoundingClientRect(); return [Math.round((e.clientX - r.left) * 10) / 10, Math.round((e.clientY - r.top) * 10) / 10]; };

// Klick ins Leere → neuer Textkasten
canvas.addEventListener('mousedown', e => {
  if (mode !== 'text' || e.target !== canvas || e.button !== 0) return;
  e.preventDefault(); const [x, y] = pt(e);
  focusEnd($('.bb', newBlock(x - 10, y - 14)));
});
canvas.addEventListener('focusout', e => {
  const bb = e.target.closest?.('.bb'); if (!bb) return;
  setTimeout(() => { const el = bb.closest('.block'); if (overlay.classList.contains('open') || menuEl) return; if (el && el.isConnected && !el.contains(document.activeElement) && isEmpty(bb)) removeBlock(el, false); }, 0);
});
// Verschieben / Breite
canvas.addEventListener('pointerdown', e => {
  const bh = e.target.closest('.bh'), br = e.target.closest('.br'); if ((!bh && !br) || e.target.closest('.bx')) return;
  e.preventDefault(); const el = e.target.closest('.block'), b = blockData(el); if (!b) return;
  const sx = e.clientX, sy = e.clientY, ox = b.x, oy = b.y, ow = b.w; let moved = false;
  const mv = ev => {
    moved = true;
    if (bh) { b.x = Math.max(0, ox + ev.clientX - sx); b.y = Math.max(0, oy + ev.clientY - sy); el.style.left = b.x + 'px'; el.style.top = b.y + 'px'; }
    else { b.w = Math.max(140, ow + ev.clientX - sx); el.style.width = b.w + 'px'; }
  };
  const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (moved) { touch(pageOf()); fitCanvas(); } };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
});
canvas.addEventListener('click', e => {
  const bx = e.target.closest('.bx'); if (bx) return removeBlock(bx.closest('.block'), true);
  const cl = e.target.closest('.cloze'); if (cl && study) { cl.classList.toggle('revealed'); return; }
  const a = e.target.closest('a');
  if (a?.classList.contains('plink')) { e.preventDefault(); if (findPage(a.dataset.page)) go(a.dataset.page); else toast('Diese Seite gibt es nicht mehr.'); return; }
  if (a?.href) { e.preventDefault(); if (e.metaKey || e.ctrlKey) window.open(a.href, '_blank', 'noopener'); else toast('Link öffnen: Strg/⌘ + Klick'); return; }
  const li = e.target.tagName === 'LI' && e.target.closest('ul.todo') ? e.target : null;
  if (li && e.offsetX < 26) { li.classList.toggle('done'); syncBlock(li.closest('.bb')); }
});
canvas.addEventListener('mousedown', e => { if (study && e.target.closest('.cloze')) e.preventDefault(); });

// Tippen
canvas.addEventListener('input', e => {
  const bb = e.target.closest?.('.bb'); if (!bb) return;
  if (!bb.firstChild || bb.innerHTML === '<br>') { bb.innerHTML = '<div><br></div>'; caretIn(bb.firstChild); }
  if (e.inputType === 'insertParagraph') selEl()?.closest('li.done')?.classList.remove('done');
  if (e.inputType === 'insertText') { if (!mdShortcut(bb)) wikiLink(); }
  syncBlock(bb);
});
function wikiLink() {
  const s = getSelection(), n = s.anchorNode; if (!n || n.nodeType !== 3) return;
  const before = n.data.slice(0, s.anchorOffset), m = before.match(/\[\[([^\[\]]{1,80})\]\]$/); if (!m) return;
  const title = m[1].trim(); if (!title) return;
  let pg = null; for (const x of allPages()) if (x.page.title.toLowerCase() === title.toLowerCase()) { pg = x.page; break; }
  if (!pg) { pg = addPage(title); toast(`Neue Seite „${title}“ angelegt`); }
  const r = document.createRange(); r.setStart(n, before.length - m[0].length); r.setEnd(n, before.length); s.removeAllRanges(); s.addRange(r);
  exec('insertHTML', `<a class="plink" data-page="${pg.id}">${esc(pg.title)}</a>&nbsp;`);
  renderNav();
}
function mdShortcut(bb) {
  const s = getSelection(); if (!s.isCollapsed) return false;
  let blk = s.anchorNode; while (blk && blk !== bb && !(blk.nodeType === 1 && /^(DIV|P)$/.test(blk.tagName))) blk = blk.parentNode;
  if (!blk || blk === bb || blk.closest('li,td,th,blockquote,pre')) return false;
  const r = document.createRange(); r.setStart(blk, 0); r.setEnd(s.anchorNode, s.anchorOffset);
  const t = r.toString(); if (t.length > 4 || !/[ \u00a0]$/.test(t)) return false;
  const k = { '#': 'h1', '##': 'h2', '###': 'h3', '>': 'blockquote', '-': 'ul', '*': 'ul', '1.': 'ol', '[]': 'todo', '```': 'pre' }[t.slice(0, -1)];
  if (!k) return false;
  r.deleteContents(); if (!blk.textContent && !blk.querySelector('br')) blk.append(document.createElement('br'));
  const c = document.createRange(); c.setStart(blk, 0); c.collapse(true); s.removeAllRanges(); s.addRange(c);
  if (k === 'ul') exec('insertUnorderedList'); else if (k === 'ol') exec('insertOrderedList'); else if (k === 'todo') toggleTodo(); else exec('formatBlock', k);
  syncBlock(bb); return true;
}
canvas.addEventListener('keydown', e => {
  const bb = e.target.closest?.('.bb'); if (!bb) return;
  if (e.key === 'Backspace' && isEmpty(bb)) { e.preventDefault(); removeBlock(bb.closest('.block'), false); return; }
  if (e.key === 'Tab') {
    e.preventDefault(); const el = selEl(), cell = el?.closest('td,th');
    if (cell) {
      const cells = $$('td,th', cell.closest('table')); let i = cells.indexOf(cell) + (e.shiftKey ? -1 : 1);
      if (i >= cells.length) { const tr = cell.parentNode, nr = tr.cloneNode(true); $$('td,th', nr).forEach(c => c.innerHTML = '<br>'); tr.after(nr); cells.push(...nr.cells); syncBlock(bb); }
      if (i >= 0) caretIn(cells[i]);
    } else if (el?.closest('li')) exec(e.shiftKey ? 'outdent' : 'indent');
    else if (!e.shiftKey) exec('insertText', '    ');
  }
});
canvas.addEventListener('paste', e => {
  const bb = e.target.closest?.('.bb'); if (!bb) return; e.preventDefault();
  const cd = e.clipboardData, files = [...cd.files].filter(f => f.type.startsWith('image/'));
  if (files.length) return files.forEach(f => insertImage(f));
  const html = cd.getData('text/html');
  if (html) exec('insertHTML', sanitize(html, true)); else exec('insertText', cd.getData('text/plain'));
});
// Bilder
async function fileToDataURL(file) {
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  if (file.size < 350e3 || file.type === 'image/gif') return url;
  const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const k = Math.min(1, 1800 / Math.max(img.width, img.height)), c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', .88);
}
async function insertImage(file, pos) {
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) return toast('Dieses Bildformat wird nicht unterstützt.');
  const bb = !pos && activeBB(), range = bb && getSelection().getRangeAt(0).cloneRange();
  let url; try { url = await fileToDataURL(file); } catch { return toast('Bild konnte nicht gelesen werden.'); }
  if (bb && bb.isConnected) { bb.focus(); const s = getSelection(); s.removeAllRanges(); s.addRange(range); exec('insertHTML', `<img src="${url}">`); syncBlock(bb); return; }
  const [x, y] = pos || [scroller.scrollLeft + 48, Math.max(20, scroller.scrollTop - canvas.offsetTop + 40)];
  const el = newBlock(x, y, `<div><img src="${url}"></div><div><br></div>`, 420);
  const im = $('img', el); const fin = () => fitCanvas(); im.complete ? fin() : im.onload = fin; touch(pageOf());
}
$('#imgFile').onchange = e => { [...e.target.files].forEach(f => insertImage(f)); e.target.value = ''; };
canvas.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
canvas.addEventListener('drop', e => {
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/')); if (!files.length) return;
  e.preventDefault(); const [x, y] = pt(e); files.forEach((f, i) => insertImage(f, [x + i * 24, y + i * 24]));
});

// ---------- Zeichnen ----------
function pathD(p) {
  if (p.length === 2) return `M${p[0]} ${p[1]}l.01 0`;
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length - 2; i += 2) d += ` Q${p[i]} ${p[i + 1]} ${(p[i] + p[i + 2]) / 2} ${(p[i + 1] + p[i + 3]) / 2}`;
  return d + ` L${p[p.length - 2]} ${p[p.length - 1]}`;
}
function strokeEl(s) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('d', pathD(s.p)); el.setAttribute('stroke', s.c === 'auto' ? 'currentColor' : s.c); el.setAttribute('stroke-width', s.w); if (s.o) el.setAttribute('stroke-opacity', s.o);
  return el;
}
function renderInk() { ink.replaceChildren(...pageOf().strokes.map(strokeEl)); }
let stroke = null, strokePath = null, erasing = false;
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy; let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function eraseAt([x, y]) {
  const p = pageOf(); let hit = false;
  p.strokes = p.strokes.filter(s => {
    const r = 7 + s.w / 2, q = s.p;
    if (q.length === 2) { if (Math.hypot(x - q[0], y - q[1]) < r) { hit = true; return false; } return true; }
    for (let i = 0; i < q.length - 2; i += 2) if (segDist(x, y, q[i], q[i + 1], q[i + 2], q[i + 3]) < r) { hit = true; return false; }
    return true;
  });
  if (hit) { renderInk(); touch(p); }
}
ink.addEventListener('pointerdown', e => {
  if (mode === 'text' || e.button !== 0) return; e.preventDefault(); ink.setPointerCapture(e.pointerId);
  const p = pt(e);
  if (mode === 'erase') { erasing = true; eraseAt(p); return; }
  const pen = state.ui.pen;
  stroke = mode === 'marker' ? { c: pen.color === 'auto' ? '#f5c400' : pen.color, w: pen.width * 6, o: .35, p } : { c: pen.color, w: pen.width, p };
  strokePath = strokeEl(stroke); ink.append(strokePath);
});
ink.addEventListener('pointermove', e => {
  if (erasing) return eraseAt(pt(e));
  if (!stroke) return;
  for (const ev of (e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e])) {
    const [x, y] = pt(ev), q = stroke.p; if (Math.hypot(x - q[q.length - 2], y - q[q.length - 1]) > 1.5) q.push(x, y);
  }
  strokePath.setAttribute('d', pathD(stroke.p));
});
const endStroke = () => {
  erasing = false; if (!stroke) return;
  const p = pageOf(); p.strokes.push(stroke); stroke = strokePath = null; touch(p); fitCanvas();
};
ink.addEventListener('pointerup', endStroke); ink.addEventListener('pointercancel', endStroke);
function undoStroke() { const p = pageOf(); if (p.strokes.pop()) { renderInk(); touch(p); } }
function setMode(m) {
  mode = m; canvas.classList.toggle('drawing', m !== 'text');
  $$('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('#drawtools').hidden = m === 'text' || m === 'erase';
  if (m !== 'text') { getSelection().removeAllRanges(); document.activeElement?.blur?.(); }
}
function renderDrawTools() {
  const pen = state.ui.pen, box = $('#drawtools'); box.innerHTML = '';
  for (const c of INK) { const b = h(`<button class="sw${pen.color === c ? ' on' : ''}" title="Farbe"></button>`); b.style.background = c === 'auto' ? 'var(--fg)' : c; b.onclick = () => { pen.color = c; renderDrawTools(); save(); }; box.append(b); }
  box.append(h('<span class="sep"></span>'));
  for (const w of [1.5, 2.5, 4.5]) { const b = h(`<button class="wbtn${pen.width === w ? ' on' : ''}" title="Strichstärke"><i style="width:${w * 2.4}px;height:${w * 2.4}px"></i></button>`); b.onclick = () => { pen.width = w; renderDrawTools(); save(); }; box.append(b); }
  const u = h('<button title="Letzten Strich zurücknehmen (Strg/⌘+Z)">↶</button>'); u.onclick = undoStroke; box.append(u);
}

// ---------- Formatierung ----------
function css(cmd, v) { exec('styleWithCSS', true); exec(cmd, v); exec('styleWithCSS', false); }
function toggleTodo() {
  const bb = activeBB(); if (!bb) return;
  const ul = selEl()?.closest('li')?.closest('ul,ol');
  if (ul?.classList.contains('todo')) { ul.classList.remove('todo'); $$('li.done', ul).forEach(l => l.classList.remove('done')); exec('insertUnorderedList'); }
  else { if (!ul || ul.tagName === 'OL') { if (ul) exec('insertOrderedList'); exec('insertUnorderedList'); } selEl()?.closest('ul')?.classList.add('todo'); }
  syncBlock(bb);
}
function setTag(tag) {
  const bb = activeBB(); if (!bb) return toast('Erst in eine Zeile klicken.');
  const blk = selEl().closest('li,div,p,h1,h2,h3,blockquote'); if (!blk || blk === bb || !bb.contains(blk)) return;
  if (!tag || blk.dataset.tag === tag) delete blk.dataset.tag; else blk.dataset.tag = tag;
  syncBlock(bb);
}
function toggleCloze() {
  const bb = activeBB(), s = getSelection(); if (!bb) return toast('Erst Text markieren, dann „Lücke“.');
  const inC = selEl().closest('.cloze');
  if (inC) { inC.replaceWith(...inC.childNodes); syncBlock(bb); return; }
  if (s.isCollapsed) return toast('Erst Text markieren, dann „Lücke“.');
  exec('insertHTML', `<span class="cloze">${esc(s.toString())}</span>`); syncBlock(bb);
}
function withSelection(fn) {
  const bb = activeBB(), range = bb && getSelection().getRangeAt(0).cloneRange();
  return async (...a) => { if (!bb || !bb.isConnected) return toast('Erst in einen Textkasten klicken.'); bb.focus(); const s = getSelection(); s.removeAllRanges(); s.addRange(range); await fn(bb, ...a); syncBlock(bb); };
}
const ACT = {
  nav: () => document.body.classList.toggle('nonav'),
  mode: b => setMode(b.dataset.mode),
  tab: b => {
    const t = b.dataset.tab;
    $$('#tabs [data-tab]').forEach(x => x.classList.toggle('on', x === b)); $$('.rb').forEach(r => r.hidden = r.dataset.rb !== t);
    if (t === 'draw') { if (mode === 'text') setMode('pen'); } else if (mode !== 'text') setMode('text');
  },
  newpage: () => newPage(),
  sync: () => Sync.dialog(),
  bold: () => exec('bold'), italic: () => exec('italic'), underline: () => exec('underline'), strike: () => exec('strikeThrough'),
  ul: () => exec('insertUnorderedList'), ol: () => exec('insertOrderedList'), todo: toggleTodo,
  clear: () => exec('removeFormat'),
  para: b => menu(b, [['Text', 'div'], ['Überschrift 1', 'h1'], ['Überschrift 2', 'h2'], ['Überschrift 3', 'h3'], ['Zitat', 'blockquote'], ['Code', 'pre']].map(([label, t]) => ({ label, fn: () => exec('formatBlock', t) }))),
  color: b => menu(b, [{ head: 'Textfarbe' }, { swatches: TEXTCOLORS, fn: c => css('foreColor', c) }, { label: 'Formatierung entfernen', fn: () => exec('removeFormat') }]),
  hilite: b => menu(b, [{ head: 'Hervorheben' }, { swatches: HILITES, fn: c => css('hiliteColor', c) }, { label: 'Keine Hervorhebung', fn: () => css('hiliteColor', 'transparent') }]),
  tag: b => menu(b, [...Object.entries(TAGS).map(([k, label]) => ({ label, fn: () => setTag(k) })), '-', { label: 'Kategorie entfernen', fn: () => setTag(null) }, { label: 'Alle Kategorien suchen …', fn: () => palette({ query: '#' }) }]),
  link: async () => {
    const run = withSelection((bb, url) => { const s = getSelection(); if (s.isCollapsed) exec('insertHTML', `<a href="${esc(url)}">${esc(url)}</a>&nbsp;`); else exec('createLink', url); });
    let url = await ask('Webadresse', 'https://', 'Verlinken'); if (!url || url === 'https://') return;
    if (!/^(https?:|mailto:)/i.test(url)) url = 'https://' + url;
    run(url);
  },
  plink: () => { const run = withSelection((bb, id) => { const x = findPage(id); exec('insertHTML', `<a class="plink" data-page="${id}">${esc(x.page.title || 'Unbenannte Seite')}</a>&nbsp;`); renderNav(); }); palette({ onPick: id => run(id), placeholder: 'Seite zum Verlinken suchen …' }); },
  table: () => { if (!activeBB()) return toast('Erst in einen Textkasten klicken.'); const row = '<tr>' + '<td><br></td>'.repeat(3) + '</tr>'; exec('insertHTML', `<table><tbody>${row.repeat(3)}</tbody></table><div><br></div>`); },
  image: () => $('#imgFile').click(),
  cloze: toggleCloze,
  study: b => { study = !study; b.classList.toggle('on', study); canvas.classList.toggle('study', study); $$('.revealed', canvas).forEach(e => e.classList.remove('revealed')); toast(study ? 'Lernmodus an – Lücken anklicken zum Aufdecken' : 'Lernmodus aus'); },
  search: () => palette(),
  paper: b => { const p = pageOf(); menu(b, [['Blanko', 'blank'], ['Liniert', 'lines'], ['Kariert', 'grid'], ['Punkte', 'dots']].map(([label, v]) => ({ label, checked: (p.paper || 'blank') === v, fn: () => { p.paper = v; canvas.dataset.paper = v; save(); } }))); },
  theme: () => { const cur = document.documentElement.dataset.theme; state.ui.theme = cur === 'dark' ? 'light' : 'dark'; applyTheme(); save(); },
  file: b => menu(b, [
    { label: 'Seite als Markdown exportieren', fn: exportMd },
    { label: 'Drucken / als PDF sichern', fn: () => print() },
    '-',
    { label: 'Backup speichern (alle Notizen)', fn: () => download(`notizwerk-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state), 'application/json') },
    { label: 'Backup laden …', fn: () => $('#jsonFile').click() },
    '-',
    { label: `Papierkorb (${state.trash.length})`, fn: showTrash }
  ])
};
$('#toolbar').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
$('#toolbar').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) ACT[b.dataset.act]?.(b); });
document.addEventListener('selectionchange', () => {
  if (!activeBB()) return;
  for (const [a, c] of [['bold', 'bold'], ['italic', 'italic'], ['underline', 'underline'], ['strike', 'strikeThrough']]) $(`[data-act=${a}]`).classList.toggle('on', document.queryCommandState(c));
});
function applyTheme() { const t = state.ui.theme; document.documentElement.dataset.theme = t === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t; }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state && applyTheme());

// ---------- Suche ----------
function palette({ onPick, placeholder, query = '' } = {}) {
  const box = h(`<div class="palette"><input placeholder="${esc(placeholder || 'Alle Notizen durchsuchen …')}"><div class="res"></div><div class="hint">↑↓ wählen · Enter öffnen · # zeigt markierte Zeilen · Esc schließt</div></div>`);
  const inp = $('input', box), res = $('.res', box); let items = [], idx = 0;
  const mark = (text, words) => { let out = esc(text); for (const w of words) if (w) out = out.replace(new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`); return out; };
  const run = () => {
    const raw = inp.value.trim(), q = raw.toLowerCase(); items = []; idx = 0;
    if (q.startsWith('#')) {
      const want = q.slice(1);
      for (const x of allPages()) for (const b of x.page.blocks) {
        if (!b.html.includes('data-tag')) continue;
        for (const el of parser.parseFromString(b.html, 'text/html').querySelectorAll('[data-tag]')) {
          const label = TAGS[el.dataset.tag] || el.dataset.tag;
          if (!want || el.dataset.tag.startsWith(want) || label.toLowerCase().includes(want)) items.push({ x, score: x.page.updated, title: esc(label), snip: esc(el.textContent.slice(0, 120)) });
        }
      }
    } else {
      const words = q.split(/\s+/).filter(Boolean);
      for (const x of allPages()) {
        const t = x.page.title || 'Unbenannte Seite', text = pageText(x.page), tl = t.toLowerCase(), cl = text.toLowerCase();
        if (!words.every(w => tl.includes(w) || cl.includes(w))) continue;
        const ci = words.length ? cl.indexOf(words.find(w => cl.includes(w)) ?? '\0') : -1;
        const from = Math.max(0, ci - 30), snip = ci >= 0 ? (from ? '…' : '') + text.slice(from, from + 110) : text.slice(0, 90);
        items.push({ x, score: (words.length && words.every(w => tl.includes(w)) ? 1e15 : 0) + x.page.updated, title: mark(t, words), snip: mark(snip, words) });
      }
    }
    items.sort((a, b) => b.score - a.score); items = items.slice(0, 40);
    if (raw && !q.startsWith('#')) items.push({ create: raw });
    draw();
  };
  const draw = () => {
    res.innerHTML = items.length ? items.map((it, i) => it.create
      ? `<div class="it${i === idx ? ' on' : ''}" data-i="${i}"><b>+ Neue Seite „${esc(it.create)}“ anlegen</b></div>`
      : `<div class="it${i === idx ? ' on' : ''}" data-i="${i}"><span class="path">${esc(it.x.nb.name)} › ${esc(it.x.sec.name)}</span><b>${it.title}</b><small>${it.snip || '&nbsp;'}</small></div>`).join('')
      : '<div class="none">Nichts gefunden.</div>';
    $('.it.on', res)?.scrollIntoView({ block: 'nearest' });
  };
  const pick = it => {
    if (!it) return; closeOverlay();
    const id = it.create ? addPage(it.create).id : it.x.page.id;
    if (onPick) onPick(id); else go(id);
  };
  inp.addEventListener('input', run);
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(items[idx]); }
  });
  res.addEventListener('click', e => { const it = e.target.closest('.it'); if (it) pick(items[+it.dataset.i]); });
  openOverlay(box); inp.value = query; inp.focus(); run();
}

// ---------- Papierkorb, Export, Import ----------
function showTrash() {
  const box = h('<div class="modal"><h3>Papierkorb</h3><div class="trash"></div><div class="row"><button class="ghost" data-a="empty">Papierkorb leeren</button><button class="primary" data-a="close">Fertig</button></div></div>');
  const draw = () => {
    $('.trash', box).innerHTML = state.trash.length ? state.trash.map(t => `<div class="tr"><div><b>${esc(t.page.title || 'Unbenannte Seite')}</b><small>${esc(t.where)} · gelöscht ${fmtDate(t.at)}</small></div><button class="ghost" data-r="${t.page.id}">Wiederherstellen</button><button data-d="${t.page.id}" title="Endgültig löschen">×</button></div>`).join('') : '<p>Der Papierkorb ist leer.</p>';
  };
  box.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.r) { closeOverlay(); restoreTrash(b.dataset.r); }
    else if (b.dataset.d) { state.trash = state.trash.filter(t => t.page.id !== b.dataset.d); save(); draw(); }
    else if (b.dataset.a === 'close') closeOverlay();
    else if (b.dataset.a === 'empty' && state.trash.length) { if (await confirmBox('Papierkorb leeren?', `${state.trash.length} Seite(n) werden endgültig gelöscht.`, 'Endgültig löschen')) { state.trash = []; save(); } showTrash(); }
  });
  draw(); openOverlay(box);
}
function md(n) {
  if (n.nodeType === 3) return n.data.replace(/ /g, ' ');
  if (n.nodeType !== 1) return '';
  const kids = (x = n) => [...x.childNodes].map(md).join('');
  switch (n.tagName) {
    case 'BR': return '\n';
    case 'B': case 'STRONG': return `**${kids()}**`;
    case 'I': case 'EM': return `*${kids()}*`;
    case 'S': case 'STRIKE': return `~~${kids()}~~`;
    case 'H1': return `\n## ${kids()}\n\n`;
    case 'H2': return `\n### ${kids()}\n\n`;
    case 'H3': return `\n#### ${kids()}\n\n`;
    case 'A': return n.dataset.page ? `[[${n.textContent}]]` : `[${kids()}](${n.getAttribute('href') || ''})`;
    case 'IMG': return '![Bild](bild)';
    case 'LI': {
      const p = n.parentNode, pre = p.tagName === 'OL' ? ([...p.children].indexOf(n) + 1) + '. ' : p.classList.contains('todo') ? (n.classList.contains('done') ? '- [x] ' : '- [ ] ') : '- ';
      return pre + kids().trim().replace(/\n/g, '\n  ') + '\n';
    }
    case 'UL': case 'OL': return '\n' + kids() + '\n';
    case 'BLOCKQUOTE': return '\n' + kids().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
    case 'PRE': return '\n```\n' + n.textContent + '\n```\n\n';
    case 'TABLE': { const rows = [...n.rows].map(r => '| ' + [...r.cells].map(c => kids(c).trim().replace(/\n/g, ' ')).join(' | ') + ' |'); if (rows.length) rows.splice(1, 0, '|' + ' --- |'.repeat(n.rows[0].cells.length)); return '\n' + rows.join('\n') + '\n\n'; }
    case 'SPAN': return n.classList.contains('cloze') ? `{{${kids()}}}` : kids();
    case 'DIV': case 'P': return (n.dataset.tag ? `**${TAGS[n.dataset.tag]}:** ` : '') + kids() + '\n';
    default: return kids();
  }
}
function exportMd() {
  const p = pageOf(), blocks = [...p.blocks].sort((a, b) => a.y - b.y || a.x - b.x);
  const body = blocks.map(b => md(parser.parseFromString(b.html, 'text/html').body).trim()).join('\n\n');
  download((p.title || 'Unbenannte Seite').replace(/[\\/:*?"<>|]/g, '_') + '.md', `# ${p.title || 'Unbenannte Seite'}\n\n${body}\n`.replace(/\n{3,}/g, '\n\n'), 'text/markdown');
}
$('#jsonFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  let data; try { data = JSON.parse(await f.text()); if (!Array.isArray(data.notebooks)) throw 0; } catch { return toast('Das ist keine gültige Notizwerk-Backup-Datei.'); }
  if (!await confirmBox('Backup laden?', 'Alle aktuellen Notizen werden durch den Inhalt des Backups ersetzt.', 'Ersetzen')) return;
  data = normalise(data);
  const clean = p => p.blocks.forEach(b => { b.html = sanitize(String(b.html || '')); });
  for (const nb of data.notebooks) for (const s of nb.sections) s.pages.forEach(clean);
  data.trash = data.trash.filter(t => t && t.page && Array.isArray(t.page.blocks)); data.trash.forEach(t => clean(t.page));
  state = data; applyTheme(); renderDrawTools(); render(); save(); toast('Backup geladen');
};

// ---------- Tastatur & Start ----------
addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod && k === 'k') { e.preventDefault(); palette(); }
  else if (e.key === 'Escape') { if (menuEl) closeMenu(); else if (overlay.classList.contains('open')) closeOverlay(); else if (mode !== 'text') setMode('text'); }
  else if (mod && k === 'z' && mode !== 'text') { e.preventDefault(); undoStroke(); }
  else if (e.altKey && e.code === 'KeyN') { e.preventDefault(); newPage(); }
});
addEventListener('pagehide', () => { if (saveT) flush(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && saveT) flush(); });
(async () => {
  state = normalise(await DB.get('state'));
  navigator.storage?.persist?.();
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) $$('kbd').forEach(k => k.textContent = k.textContent.replace('⌘', 'Strg+'));
  if (innerWidth <= 820) document.body.classList.add('nonav');
  applyTheme(); renderDrawTools(); render(); $('#saveState').textContent = 'Gespeichert';
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
  if (typeof Sync !== 'undefined') Sync.start();
})();
