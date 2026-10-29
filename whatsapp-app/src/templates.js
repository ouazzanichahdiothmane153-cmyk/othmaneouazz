// Remplace {{champ}} dans le texte par la valeur du contact.
export function renderBody(body, fields) {
  return body.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => String(fields[key] ?? ''));
}

// Valeurs des paramètres d'un modèle WhatsApp, dans l'ordre déclaré (params = ["name", "city"]).
export function templateParams(paramNames, fields) {
  return paramNames.map((key) => String(fields[key] ?? ''));
}

// Champs disponibles pour un contact : colonnes fixes + données importées.
export function contactFields(contact) {
  return { phone: contact.phone, name: contact.name, tags: contact.tags, ...JSON.parse(contact.data || '{}') };
}
