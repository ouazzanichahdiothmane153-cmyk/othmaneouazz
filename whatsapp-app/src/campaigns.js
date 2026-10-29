import { config } from './config.js';
import { contactFields, templateParams, renderBody } from './templates.js';
import { sendTemplate } from './whatsapp.js';

const now = () => Date.now();

export function listTemplates(db) {
  return db.prepare('SELECT * FROM templates ORDER BY id DESC').all().map(publicTemplate);
}

export function createTemplate(db, { name, wa_name, language = 'fr', body, params = [] }) {
  if (!name || !wa_name || !body) throw new Error('name, wa_name et body sont requis');
  const list = Array.isArray(params) ? params : String(params).split(',').map((p) => p.trim()).filter(Boolean);
  const res = db.prepare(`
    INSERT INTO templates (name, wa_name, language, body, params, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, wa_name, language, body, JSON.stringify(list), now());
  return publicTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(res.lastInsertRowid));
}

export function publicTemplate(row) {
  return { ...row, params: JSON.parse(row.params) };
}

// Crée une campagne et met en file un message par contact ciblé.
// Les contacts ayant refusé (opt-out) sont exclus.
export function createCampaign(db, { name, template_id, tag = '', scheduled_at }) {
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(template_id);
  if (!template) throw new Error('Modèle introuvable');

  const startAt = scheduled_at ? Date.parse(scheduled_at) : now();
  if (Number.isNaN(startAt)) throw new Error('scheduled_at invalide');

  const tagFilter = String(tag).trim().toLowerCase();
  const contacts = db.prepare(`
    SELECT * FROM contacts
    WHERE opted_out = 0 AND (? = '' OR ',' || tags || ',' LIKE '%,' || ? || ',%')
  `).all(tagFilter, tagFilter);
  if (!contacts.length) throw new Error('Aucun contact éligible pour ce ciblage');

  db.exec('BEGIN');
  try {
    const res = db.prepare(`
      INSERT INTO campaigns (name, template_id, tag, status, scheduled_at, created_at) VALUES (?, ?, ?, 'scheduled', ?, ?)
    `).run(name || template.name, template.id, tagFilter, startAt, now());
    const campaignId = Number(res.lastInsertRowid);

    const insert = db.prepare(`
      INSERT INTO messages (campaign_id, contact_id, phone, params, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const contact of contacts) {
      const fields = contactFields(contact);
      insert.run(
        campaignId,
        contact.id,
        contact.phone,
        JSON.stringify(templateParams(JSON.parse(template.params), fields)),
        renderBody(template.body, fields),
        now(),
      );
    }
    db.exec('COMMIT');
    return getCampaign(db, campaignId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getCampaign(db, id) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!campaign) return null;
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n FROM messages WHERE campaign_id = ? GROUP BY status
  `).all(id);
  return { ...campaign, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
}

export function listCampaigns(db) {
  return db.prepare('SELECT id FROM campaigns ORDER BY id DESC LIMIT 100').all().map((r) => getCampaign(db, r.id));
}

export function cancelCampaign(db, id) {
  db.prepare("UPDATE messages SET status = 'cancelled', updated_at = ? WHERE campaign_id = ? AND status = 'queued'")
    .run(now(), id);
  return db.prepare("UPDATE campaigns SET status = 'cancelled' WHERE id = ? AND status IN ('scheduled','running')")
    .run(id).changes > 0;
}

// Envoie les messages en attente des campagnes dont l'heure est atteinte.
// Appelé en boucle par le worker ; retourne le nombre de messages traités.
let busy = false;
export async function processQueue(db, { batch = 20 } = {}) {
  if (busy) return 0;
  busy = true;
  let processed = 0;
  try {
    const due = db.prepare(`
      SELECT id FROM campaigns WHERE status IN ('scheduled','running') AND scheduled_at <= ?
      ORDER BY scheduled_at LIMIT 10
    `).all(now());

    for (const { id } of due) {
      db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(id);
      const template = db.prepare(`
        SELECT t.* FROM templates t JOIN campaigns c ON c.template_id = t.id WHERE c.id = ?
      `).get(id);

      const queued = db.prepare(`
        SELECT * FROM messages WHERE campaign_id = ? AND status = 'queued' ORDER BY id LIMIT ?
      `).all(id, batch);

      for (const msg of queued) {
        await sendOne(db, msg, template);
        processed += 1;
        if (config.sendDelayMs) await new Promise((r) => setTimeout(r, config.sendDelayMs));
      }

      const left = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE campaign_id = ? AND status = 'queued'").get(id).n;
      if (left === 0) db.prepare("UPDATE campaigns SET status = 'done' WHERE id = ?").run(id);
    }
  } finally {
    busy = false;
  }
  return processed;
}

async function sendOne(db, msg, template) {
  const attempts = msg.attempts + 1;
  try {
    const { id } = await sendTemplate({
      to: msg.phone,
      waName: template.wa_name,
      language: template.language,
      params: JSON.parse(msg.params),
    });
    db.prepare("UPDATE messages SET status = 'sent', wa_message_id = ?, attempts = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(id ?? null, attempts, now(), msg.id);
  } catch (err) {
    const final = attempts >= config.maxAttempts;
    db.prepare('UPDATE messages SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(final ? 'failed' : 'queued', attempts, err.message, now(), msg.id);
  }
}
