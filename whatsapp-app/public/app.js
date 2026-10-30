const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (ms) => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const STORE = 'wa-admin-token';
const THEME = 'wa-theme';
const LABELS = { queued: 'en attente', sent: 'envoyé', delivered: 'livré', read: 'lu', failed: 'échec', cancelled: 'annulé', scheduled: 'programmée', running: 'en cours', done: 'terminée', actif: 'actif', stop: 'STOP' };
const pill = (s) => `<span class="pill ${esc(s)}">${esc(LABELS[s] ?? s)}</span>`;

let token = null;
try { token = sessionStorage.getItem(STORE); } catch {}
let templatesCache = [];

// Thème
function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}
try { applyTheme(localStorage.getItem(THEME)); } catch {}
$('#theme').addEventListener('click', () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const current = document.documentElement.getAttribute('data-theme') || (dark ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME, next); } catch {}
});

// API
async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(options.raw ? { 'Content-Type': 'text/csv' } : options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.raw ?? (options.body ? JSON.stringify(options.body) : undefined),
  });
  if (res.status === 401) { logout(); throw new Error('Session expirée, reconnectez-vous.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 3500);
}

// Connexion
function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
}
function logout() {
  token = null;
  try { sessionStorage.removeItem(STORE); } catch {}
  showLogin();
}
$('#logout').addEventListener('click', logout);

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = new FormData(e.target).get('token').trim();
  try {
    await api('/api/stats');
    try { sessionStorage.setItem(STORE, token); } catch {}
    $('#login-error').classList.add('hidden');
    start();
  } catch {
    token = null;
    $('#login-error').classList.remove('hidden');
  }
});

// Navigation (routes par hash)
const TITLES = { overview: "Vue d'ensemble", contacts: 'Contacts', templates: 'Modèles', campaigns: 'Campagnes' };
function route() {
  const page = (location.hash || '#overview').slice(1) in TITLES ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === page));
  document.querySelectorAll('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  $('#page-title').textContent = TITLES[page];
}
window.addEventListener('hashchange', route);

async function start() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  route();
  const status = await api('/api/status');
  $('#mode').textContent = status.dryRun ? 'Mode simulation' : 'WhatsApp connecté';
  $('#mode').classList.toggle('live', !status.dryRun);
  await refresh();
  setInterval(refresh, 15000);
}

// Chargement des données
async function refresh() {
  try {
    const [stats, contacts, templates, campaigns] = await Promise.all([
      api('/api/stats'),
      api(`/api/contacts?${new URLSearchParams({ q: $('#search-form [name=q]').value, tag: $('#search-form [name=tag]').value })}`),
      api('/api/templates'),
      api('/api/campaigns'),
    ]);
    templatesCache = templates;
    renderStats(stats);
    renderContacts(contacts);
    renderTemplates(templates);
    renderCampaigns(campaigns);
    $('#updated').textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR', { timeStyle: 'short' })}`;
  } catch (err) {
    if (token) toast(err.message, true);
  }
}

function renderStats(s) {
  const m = s.messages;
  const sent = (m.sent ?? 0) + (m.delivered ?? 0) + (m.read ?? 0);
  const delivered = (m.delivered ?? 0) + (m.read ?? 0);
  const items = [
    ['Contacts', s.contacts, ''],
    ['Messages envoyés', sent, ''],
    ['Livrés / lus', delivered, 'accent'],
    ['En attente', m.queued ?? 0, ''],
    ['Échecs', m.failed ?? 0, ''],
    ['Opt-out (STOP)', s.optedOut, ''],
  ];
  $('#stats').innerHTML = items.map(([l, n, cls]) =>
    `<div class="stat"><div class="label">${l}</div><div class="value ${cls}">${n}</div></div>`).join('');
  $('#contact-count').textContent = `(${s.contacts})`;
}

function renderContacts(list) {
  $('#contacts').innerHTML = `
    <tr><th>Numéro</th><th>Nom</th><th>Tags</th><th>Ville</th><th>Statut</th><th></th></tr>
    ${list.map((c) => `
      <tr>
        <td>${esc(c.phone)}</td><td>${esc(c.name)}</td><td>${esc(c.tags)}</td><td>${esc(c.data?.city)}</td>
        <td>${pill(c.opted_out ? 'stop' : 'actif')}</td>
        <td><button class="btn ghost small" data-del="${c.id}">Supprimer</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">Aucun contact pour l\'instant</td></tr>'}`;
  // Aperçu des contacts sur la vue d'ensemble : rien à faire ici
}

function renderTemplates(list) {
  $('#templates').innerHTML = list.map((t) => `
    <div class="list-item">
      <strong>${esc(t.name)}</strong> <span class="meta">· ${esc(t.wa_name)} · ${esc(t.language)}</span>
      <div class="meta">${esc(t.body)}</div>
    </div>`).join('') || '<p class="empty">Aucun modèle</p>';

  const current = $('#template-select').value;
  $('#template-select').innerHTML = list.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  if (current) $('#template-select').value = current;
}

function renderCampaigns(list) {
  const rows = list.map((c) => {
    const total = Object.values(c.counts).reduce((a, b) => a + b, 0);
    const parts = Object.entries(c.counts).map(([k, v]) => `${v} ${LABELS[k] ?? k}`).join(' · ') || '—';
    return `<tr>
      <td>${esc(c.name)}${c.tag ? ` <span class="meta">[${esc(c.tag)}]</span>` : ''}</td>
      <td>${pill(c.status)}</td>
      <td>${fmtDate(c.scheduled_at)}</td>
      <td>${total}</td>
      <td class="wrap">${esc(parts)}</td>
      <td>${['scheduled', 'running'].includes(c.status) ? `<button class="btn ghost small" data-cancel="${c.id}">Annuler</button>` : ''}</td>
    </tr>`;
  }).join('');
  const head = `<tr><th>Campagne</th><th>Statut</th><th>Envoi prévu</th><th>Total</th><th>Détail</th><th></th></tr>`;
  $('#campaigns').innerHTML = head + (rows || '<tr><td colspan="6" class="empty">Aucune campagne</td></tr>');
  $('#recent-campaigns').innerHTML = head.replace('<th></th>', '') + (list.slice(0, 5).map((c) => `<tr>
      <td>${esc(c.name)}</td><td>${pill(c.status)}</td><td>${fmtDate(c.scheduled_at)}</td>
      <td>${Object.values(c.counts).reduce((a, b) => a + b, 0)}</td><td class="wrap">${esc(Object.entries(c.counts).map(([k, v]) => `${v} ${LABELS[k] ?? k}`).join(' · ') || '—')}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">Aucune campagne pour l\'instant</td></tr>');
}

// Formulaires
$('#csv-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = await api('/api/contacts/csv', { method: 'POST', raw: await file.text() });
    toast(`${data.imported} contact(s) importé(s)${data.errors.length ? `, ${data.errors.length} erreur(s)` : ''}`);
    refresh();
  } catch (err) { toast(err.message, true); }
  e.target.value = '';
});

$('#contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/contacts', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    toast('Contact ajouté');
    refresh();
  } catch (err) { toast(err.message, true); }
});

$('#search-form').addEventListener('input', refresh);

$('#contacts').addEventListener('click', async (e) => {
  const id = e.target.dataset.del;
  if (!id || !confirm('Supprimer ce contact ?')) return;
  try {
    await api(`/api/contacts/${id}`, { method: 'DELETE' });
    refresh();
  } catch (err) { toast(err.message, true); }
});

$('#template-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/templates', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    toast('Modèle créé');
    refresh();
  } catch (err) { toast(err.message, true); }
});

$('#campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.target));
  if (!form.scheduled_at) delete form.scheduled_at;
  else form.scheduled_at = new Date(form.scheduled_at).toISOString();
  form.template_id = Number(form.template_id);
  try {
    const c = await api('/api/campaigns', { method: 'POST', body: form });
    const total = Object.values(c.counts ?? {}).reduce((a, b) => a + b, 0);
    toast(`Campagne créée : ${total} message(s)`);
    e.target.reset();
    refresh();
  } catch (err) { toast(err.message, true); }
});

$('#campaigns').addEventListener('click', async (e) => {
  const id = e.target.dataset.cancel;
  if (!id || !confirm('Annuler les messages restants de cette campagne ?')) return;
  try {
    await api(`/api/campaigns/${id}/cancel`, { method: 'POST' });
    refresh();
  } catch (err) { toast(err.message, true); }
});

// Démarrage
route();
if (token) start().catch(() => showLogin());
else showLogin();
