const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STORE = 'wa-admin-token';

let token = null;
try { token = sessionStorage.getItem(STORE); } catch {}

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.body && !isForm ? JSON.stringify(options.body) : options.body,
  });
  if (res.status === 401) { logout(); throw new Error('Session expirée'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.background = isError ? 'var(--danger)' : '';
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 3500);
}

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#logout').classList.add('hidden');
}

function logout() {
  token = null;
  try { sessionStorage.removeItem(STORE); } catch {}
  showLogin();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = new FormData(e.target).get('token').trim();
  try {
    await api('/api/stats');
    try { sessionStorage.setItem(STORE, token); } catch {}
    $('#login-error').classList.add('hidden');
    start();
  } catch (err) {
    token = null;
    $('#login-error').textContent = 'Jeton refusé.';
    $('#login-error').classList.remove('hidden');
  }
});

$('#logout').addEventListener('click', logout);

async function start() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#logout').classList.remove('hidden');
  const status = await api('/api/status');
  $('#mode').textContent = status.dryRun ? 'Mode simulation' : 'Connecté à WhatsApp';
  $('#mode').classList.toggle('live', !status.dryRun);
  await refresh();
  setInterval(refresh, 15000);
}

async function refresh() {
  try {
    const [stats, contacts, templates, campaigns] = await Promise.all([
      api('/api/stats'),
      api(`/api/contacts?${new URLSearchParams({ q: $('#search-form [name=q]').value, tag: $('#search-form [name=tag]').value })}`),
      api('/api/templates'),
      api('/api/campaigns'),
    ]);
    renderStats(stats);
    renderContacts(contacts);
    renderTemplates(templates);
    renderCampaigns(campaigns);
  } catch (err) {
    if (token) toast(err.message, true);
  }
}

function renderStats(s) {
  const m = s.messages;
  const items = [
    ['Contacts', s.contacts], ['Opt-out', s.optedOut], ['En attente', m.queued ?? 0],
    ['Envoyés', (m.sent ?? 0) + (m.delivered ?? 0) + (m.read ?? 0)], ['Lus', m.read ?? 0], ['Échecs', m.failed ?? 0],
  ];
  $('#stats').innerHTML = items.map(([label, n]) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`).join('');
  $('#contact-count').textContent = `(${s.contacts})`;
}

function renderContacts(list) {
  $('#contacts').innerHTML = `
    <tr><th>Numéro</th><th>Nom</th><th>Tags</th><th>Statut</th><th></th></tr>
    ${list.map((c) => `
      <tr>
        <td>${esc(c.phone)}</td><td>${esc(c.name)}</td><td>${esc(c.tags)}</td>
        <td>${c.opted_out ? '<span class="pill failed">STOP</span>' : '<span class="pill sent">actif</span>'}</td>
        <td><button class="ghost" data-del="${c.id}">Supprimer</button></td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">Aucun contact</td></tr>'}`;
}

function renderTemplates(list) {
  $('#templates').innerHTML = list.map((t) => `
    <li><b>${esc(t.name)}</b> <span class="muted">· ${esc(t.wa_name)} · ${esc(t.language)}</span><br />
    <span class="muted">${esc(t.body)}</span></li>`).join('') || '<li class="muted">Aucun modèle</li>';
  const current = $('#template-select').value;
  $('#template-select').innerHTML = list.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  if (current) $('#template-select').value = current;
}

function renderCampaigns(list) {
  $('#campaigns').innerHTML = `
    <tr><th>Campagne</th><th>Statut</th><th>Envoi prévu</th><th>Messages</th><th></th></tr>
    ${list.map((c) => {
      const counts = Object.entries(c.counts).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
      return `<tr>
        <td>${esc(c.name)}${c.tag ? ` <span class="muted">[${esc(c.tag)}]</span>` : ''}</td>
        <td><span class="pill ${esc(c.status)}">${esc(c.status)}</span></td>
        <td>${new Date(c.scheduled_at).toLocaleString('fr-FR')}</td>
        <td class="wrap">${esc(counts)}</td>
        <td>${['scheduled', 'running'].includes(c.status) ? `<button class="ghost" data-cancel="${c.id}">Annuler</button>` : ''}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">Aucune campagne</td></tr>'}`;
}

$('#csv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = e.target.file.files[0];
  try {
    const res = await fetch('/api/contacts/csv', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv' },
      body: await file.text(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`${data.imported} contact(s) importé(s)${data.errors.length ? `, ${data.errors.length} erreur(s)` : ''}`);
    e.target.reset();
    refresh();
  } catch (err) { toast(err.message, true); }
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
  await api(`/api/contacts/${id}`, { method: 'DELETE' });
  refresh();
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
    toast(`Campagne lancée : ${Object.values(c.counts ?? {}).reduce((a, b) => a + b, 0)} message(s)`);
    e.target.reset();
    refresh();
  } catch (err) { toast(err.message, true); }
});

$('#campaigns').addEventListener('click', async (e) => {
  const id = e.target.dataset.cancel;
  if (!id || !confirm('Annuler les messages restants de cette campagne ?')) return;
  await api(`/api/campaigns/${id}/cancel`, { method: 'POST' });
  refresh();
});

if (token) start().catch(() => showLogin());
else showLogin();
