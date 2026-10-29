import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ADMIN_TOKEN = 'test-token';
process.env.DB_FILE = ':memory:';
process.env.SEND_DELAY_MS = '0';
process.env.DEFAULT_COUNTRY_CODE = '212';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';

const { normalizePhone } = await import('../src/phone.js');
const { parseCsv } = await import('../src/contacts.js');
const { renderBody, templateParams } = await import('../src/templates.js');
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');
const { processQueue } = await import('../src/campaigns.js');
const { handleWebhook } = await import('../src/webhook.js');

test('normalisation des numéros', () => {
  assert.equal(normalizePhone('0655 04 70 42'), '212655047042');
  assert.equal(normalizePhone('+33 6 11 22 33 44'), '33611223344');
  assert.equal(normalizePhone('0033611223344'), '33611223344');
  assert.equal(normalizePhone('123'), null);
});

test('lecture CSV avec guillemets et point-virgule', () => {
  const rows = parseCsv('Phone;Name;Tags\r\n0655047042;"Ali, Bob";vip|promo\r\n');
  assert.deepEqual(rows, [{ phone: '0655047042', name: 'Ali, Bob', tags: 'vip|promo' }]);
});

test('rendu des variables', () => {
  const fields = { name: 'Sara', city: 'Fès' };
  assert.equal(renderBody('Bonjour {{ name }}, à {{city}}', fields), 'Bonjour Sara, à Fès');
  assert.deepEqual(templateParams(['city', 'name'], fields), ['Fès', 'Sara']);
});

// Application complète sur base en mémoire, avec un serveur HTTP réel.
async function setup() {
  const db = openDb(':memory:');
  const server = createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = 'GET', body, token = 'test-token', raw } = {}) => fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': 'text/csv' } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  return { db, server, base, call };
}

test('API protégée par jeton', async () => {
  const { server, call } = await setup();
  try {
    assert.equal((await call('/api/stats', { token: 'bad' })).status, 401);
    assert.equal((await call('/api/stats')).status, 200);
  } finally { server.close(); }
});

test('intégration : import JSON + CSV, modèle, campagne, envoi, statut, STOP', async () => {
  const { db, server, call } = await setup();
  try {
    // 1. La base du client pousse ses contacts (tableau JSON)
    let res = await call('/api/contacts/import', {
      method: 'POST',
      body: { contacts: [
        { phone: '0655047042', name: 'Ali', tags: 'vip', city: 'Fès' },
        { phone: '0611223344', name: 'Sara', tags: 'promo', city: 'Casa' },
        { phone: 'abc', name: 'Erreur' },
      ] },
    });
    let data = await res.json();
    assert.equal(data.imported, 2);
    assert.equal(data.errors.length, 1);

    // 2. Import CSV
    res = await call('/api/contacts/csv', { method: 'POST', raw: 'phone,name,tags,city\n0700000001,Nadia,vip,Rabat\n' });
    assert.equal((await res.json()).imported, 1);

    // 3. Modèle approuvé
    res = await call('/api/templates', { method: 'POST', body: { name: 'Rappel', wa_name: 'rappel_rdv', language: 'fr', body: 'Bonjour {{name}}, RDV à {{city}}', params: 'name,city' } });
    assert.equal(res.status, 201);
    const template = await res.json();

    // 4. Campagne ciblée sur le tag "vip" (2 contacts)
    res = await call('/api/campaigns', { method: 'POST', body: { name: 'VIP', template_id: template.id, tag: 'VIP' } });
    assert.equal(res.status, 201);
    const campaign = await res.json();
    assert.equal(campaign.counts.queued, 2);

    // 5. Le worker envoie (mode simulation : pas de jeton WhatsApp)
    const sent = await processQueue(db);
    assert.equal(sent, 2);
    const done = await (await call(`/api/campaigns/${campaign.id}`)).json();
    assert.equal(done.status, 'done');
    assert.equal(done.counts.sent, 2);

    // 6. Accusés de réception Meta
    const wa = db.prepare('SELECT wa_message_id FROM messages WHERE campaign_id = ? LIMIT 1').get(campaign.id).wa_message_id;
    handleWebhook(db, { entry: [{ changes: [{ value: { statuses: [{ id: wa, status: 'read' }] } }] }] });
    handleWebhook(db, { entry: [{ changes: [{ value: { statuses: [{ id: wa, status: 'delivered' }] } }] }] }); // pas de retour arrière
    assert.equal(db.prepare('SELECT status FROM messages WHERE wa_message_id = ?').get(wa).status, 'read');

    // 7. Un contact répond STOP : opt-out et plus aucun envoi futur
    const phone = db.prepare("SELECT phone FROM contacts WHERE tags LIKE '%promo%'").get().phone;
    res = await call('/api/campaigns', { method: 'POST', body: { name: 'Promo', template_id: template.id, tag: 'promo' } });
    const promo = await res.json();
    handleWebhook(db, { entry: [{ changes: [{ value: { messages: [{ from: phone, type: 'text', text: { body: ' stop ' } }] } }] }] });
    const after = await (await call(`/api/campaigns/${promo.id}`)).json();
    assert.equal(after.counts.cancelled, 1);
    assert.equal((await (await call('/api/stats')).json()).optedOut, 1);

    // 8. Ciblage : les opt-out ne reçoivent jamais de campagne
    res = await call('/api/campaigns', { method: 'POST', body: { name: 'Tous', template_id: template.id } });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).counts.queued, 2);

    // 9. Erreur métier lisible
    res = await call('/api/campaigns', { method: 'POST', body: { name: 'X', template_id: 999 } });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

test('échec d\'envoi : nouvelle tentative puis statut failed', async () => {
  const { db, server, call } = await setup();
  try {
    await call('/api/contacts', { method: 'POST', body: { phone: '0655047042', name: 'Ali' } });
    const t = await (await call('/api/templates', { method: 'POST', body: { name: 'T', wa_name: 'wa', body: 'Hi {{name}}' } })).json();
    const c = await (await call('/api/campaigns', { method: 'POST', body: { template_id: t.id } })).json();
    // Forcer un échec : un jeton WhatsApp factice mais un appel réseau impossible
    const { config } = await import('../src/config.js');
    const saved = config.whatsapp.token;
    config.whatsapp.token = 'fake';
    config.whatsapp.phoneNumberId = '1';
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 400 });
    try {
      await processQueue(db);
      const msg = db.prepare('SELECT * FROM messages WHERE campaign_id = ?').get(c.id);
      assert.equal(msg.status, 'queued');
      assert.equal(msg.attempts, 1);
      await processQueue(db); await processQueue(db);
      const last = db.prepare('SELECT * FROM messages WHERE campaign_id = ?').get(c.id);
      assert.equal(last.status, 'failed');
      assert.equal(last.error, 'boom');
    } finally {
      globalThis.fetch = savedFetch;
      config.whatsapp.token = saved;
    }
  } finally { server.close(); }
});

test('webhook : vérification Meta', async () => {
  const { server, base } = await setup();
  try {
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=123`);
    assert.equal(await ok.text(), '123');
    const ko = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123`);
    assert.equal(ko.status, 403);
  } finally { server.close(); }
});
