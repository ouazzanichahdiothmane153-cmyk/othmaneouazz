import { config, isDryRun } from './config.js';
import { randomUUID } from 'node:crypto';

// Envoie un message de modèle approuvé via la WhatsApp Cloud API.
// Les messages envoyés en dehors d'une fenêtre de 24 h doivent obligatoirement utiliser un modèle.
export async function sendTemplate({ to, waName, language, params }) {
  if (isDryRun()) {
    console.log(`[dry-run] -> ${to} (${waName}/${language}) ${JSON.stringify(params)}`);
    return { id: `dry-${randomUUID()}` };
  }

  const { token, phoneNumberId, apiVersion } = config.whatsapp;
  const components = params.length
    ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
    : [];

  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: waName, language: { code: language }, components },
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return { id: json.messages?.[0]?.id };
}
