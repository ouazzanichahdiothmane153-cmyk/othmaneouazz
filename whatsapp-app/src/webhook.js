import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

// Vérifie la signature X-Hub-Signature-256 envoyée par Meta (si WHATSAPP_APP_SECRET est défini).
export function verifySignature(rawBody, header) {
  if (!config.whatsapp.appSecret) return true;
  if (!header) return false;
  const expected = 'sha256=' + createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };

// Met à jour les statuts (sent / delivered / read / failed) et gère les réponses "STOP".
export function handleWebhook(db, payload) {
  const now = Date.now();
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      for (const st of value.statuses ?? []) {
        if (st.status === 'failed') {
          db.prepare("UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE wa_message_id = ?")
            .run(st.errors?.[0]?.title ?? 'failed', now, st.id);
        } else if (STATUS_RANK[st.status] !== undefined) {
          const current = db.prepare('SELECT status FROM messages WHERE wa_message_id = ?').get(st.id);
          if (current && STATUS_RANK[st.status] > (STATUS_RANK[current.status] ?? -1)) {
            db.prepare('UPDATE messages SET status = ?, updated_at = ? WHERE wa_message_id = ?')
              .run(st.status, now, st.id);
          }
        }
      }

      for (const msg of value.messages ?? []) {
        if (msg.type === 'text' && /^\s*stop\s*$/i.test(msg.text?.body ?? '')) {
          db.prepare('UPDATE contacts SET opted_out = 1, updated_at = ? WHERE phone = ?').run(now, msg.from);
          db.prepare("UPDATE messages SET status = 'cancelled', updated_at = ? WHERE phone = ? AND status = 'queued'")
            .run(now, msg.from);
        }
      }
    }
  }
}
