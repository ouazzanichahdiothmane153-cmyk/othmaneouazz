import { normalizePhone } from './phone.js';

const now = () => Date.now();

// Insère ou met à jour un contact (clé : numéro). Les opt-out ne sont jamais réinitialisés.
export function upsertContact(db, { phone, name = '', tags = '', ...extra }) {
  const normalized = normalizePhone(phone);
  if (!normalized) return { error: `Numéro invalide : ${phone}` };

  const data = JSON.stringify(extra);
  db.prepare(`
    INSERT INTO contacts (phone, name, tags, data, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name = excluded.name, tags = excluded.tags, data = excluded.data, updated_at = excluded.updated_at
  `).run(normalized, String(name), normalizeTags(tags), data, now());
  return { phone: normalized };
}

export function importContacts(db, rows) {
  const result = { imported: 0, errors: [] };
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const res = upsertContact(db, row);
      if (res.error) result.errors.push(res.error);
      else result.imported += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

// Lit un CSV (1re ligne = en-têtes, séparateur "," ou ";", guillemets gérés).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const clean = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';') { row.push(field.trim()); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.trim() || row.length) { row.push(field.trim()); rows.push(row); }

  const [headers, ...body] = rows.filter((r) => r.some((v) => v !== ''));
  if (!headers) return [];
  const keys = headers.map((h) => h.toLowerCase());
  return body.map((values) => Object.fromEntries(keys.map((k, i) => [k, values[i] ?? ''])));
}

export function listContacts(db, { tag = '', q = '', limit = 200 } = {}) {
  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT * FROM contacts
    WHERE (? = '' OR ',' || tags || ',' LIKE '%,' || ? || ',%')
      AND (? = '' OR name LIKE ? OR phone LIKE ?)
    ORDER BY updated_at DESC LIMIT ?
  `).all(tag, tag, q, like, like, limit);
  return rows.map(publicContact);
}

export function deleteContact(db, id) {
  return db.prepare('DELETE FROM contacts WHERE id = ?').run(id).changes > 0;
}

export function publicContact(row) {
  return { ...row, opted_out: !!row.opted_out, data: JSON.parse(row.data || '{}') };
}

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags).split(/[,|]/);
  return [...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))].join(',');
}
