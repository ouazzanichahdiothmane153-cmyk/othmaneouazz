import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isDryRun } from './config.js';
import { openDb } from './db.js';
import { importContacts, listContacts, deleteContact, parseCsv, upsertContact } from './contacts.js';
import { createTemplate, listTemplates, createCampaign, getCampaign, listCampaigns, cancelCampaign, processQueue } from './campaigns.js';
import { handleWebhook, verifySignature } from './webhook.js';

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_BODY = 5 * 1024 * 1024;

export function createApp(db) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/webhook') return await webhook(req, res, url, db);
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req)) return json(res, 401, { error: 'Non autorisé' });
        return await api(req, res, url, db);
      }
      return await staticFile(res, url.pathname);
    } catch (err) {
      if (!err.expose) console.error(err);
      return json(res, err.status ?? 500, { error: err.expose ? err.message : 'Erreur serveur' });
    }
  };
}

function authorized(req) {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(config.adminToken);
  return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

async function api(req, res, url, db) {
  const { pathname, searchParams } = url;
  const method = req.method;
  const seg = pathname.split('/').filter(Boolean); // ['api', resource, id?, action?]

  if (method === 'GET' && pathname === '/api/status') {
    return json(res, 200, { dryRun: isDryRun(), workerIntervalMs: config.workerIntervalMs });
  }

  if (method === 'GET' && pathname === '/api/stats') {
    const contacts = db.prepare('SELECT COUNT(*) AS n, SUM(opted_out) AS out FROM contacts').get();
    const messages = db.prepare('SELECT status, COUNT(*) AS n FROM messages GROUP BY status').all();
    return json(res, 200, {
      contacts: contacts.n,
      optedOut: contacts.out ?? 0,
      messages: Object.fromEntries(messages.map((m) => [m.status, m.n])),
      dryRun: isDryRun(),
    });
  }

  // Contacts
  if (seg[1] === 'contacts') {
    if (method === 'GET' && seg.length === 2) {
      return json(res, 200, listContacts(db, {
        tag: searchParams.get('tag') ?? '',
        q: searchParams.get('q') ?? '',
      }));
    }
    // Intégration : envoyer une liste de contacts en JSON depuis la base du client.
    if (method === 'POST' && seg[2] === 'import') {
      const body = await readBody(req);
      const rows = Array.isArray(body) ? body : body.contacts;
      if (!Array.isArray(rows)) return json(res, 400, { error: 'Attendu : tableau de contacts' });
      return json(res, 200, importContacts(db, rows));
    }
    // Import CSV (corps de la requête = contenu du fichier).
    if (method === 'POST' && seg[2] === 'csv') {
      const text = await readText(req);
      return json(res, 200, importContacts(db, parseCsv(text)));
    }
    if (method === 'POST' && seg.length === 2) {
      const row = await readBody(req);
      const result = upsertContact(db, row);
      return json(res, result.error ? 400 : 200, result);
    }
    if (method === 'DELETE' && seg.length === 3) {
      return json(res, deleteContact(db, Number(seg[2])) ? 200 : 404, { ok: true });
    }
  }

  // Modèles
  if (seg[1] === 'templates') {
    if (method === 'GET') return json(res, 200, listTemplates(db));
    if (method === 'POST') {
      const input = await readBody(req);
      return json(res, 201, validated(() => createTemplate(db, input)));
    }
  }

  // Campagnes
  if (seg[1] === 'campaigns') {
    if (method === 'GET' && seg.length === 2) return json(res, 200, listCampaigns(db));
    if (method === 'GET' && seg.length === 3) {
      const campaign = getCampaign(db, Number(seg[2]));
      return json(res, campaign ? 200 : 404, campaign ?? { error: 'Introuvable' });
    }
    if (method === 'POST' && seg.length === 2) {
      const input = await readBody(req);
      return json(res, 201, validated(() => createCampaign(db, input)));
    }
    if (method === 'POST' && seg[3] === 'cancel') {
      return json(res, cancelCampaign(db, Number(seg[2])) ? 200 : 404, { ok: true });
    }
  }

  return json(res, 404, { error: 'Route introuvable' });
}

// Webhook Meta : vérification (GET) et réception des statuts / réponses (POST).
async function webhook(req, res, url, db) {
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe'
      && url.searchParams.get('hub.verify_token') === config.whatsapp.verifyToken
      && config.whatsapp.verifyToken !== '';
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'text/plain' });
    return res.end(ok ? url.searchParams.get('hub.challenge') : 'forbidden');
  }
  if (req.method === 'POST') {
    const raw = await readText(req);
    if (!verifySignature(raw, req.headers['x-hub-signature-256'])) return json(res, 401, { error: 'Signature invalide' });
    handleWebhook(db, JSON.parse(raw || '{}'));
    res.writeHead(200);
    return res.end();
  }
  res.writeHead(405);
  return res.end();
}

async function staticFile(res, pathname) {
  const safe = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(join(PUBLIC_DIR, safe));
    res.writeHead(200, { 'Content-Type': MIME[extname(safe)] ?? 'application/octet-stream' });
    return res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Introuvable');
  }
}

// Erreurs de validation métier -> réponse 400 avec un message lisible.
function validated(fn) {
  try {
    return fn();
  } catch (err) {
    throw Object.assign(err, { status: 400, expose: true });
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readText(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Requête trop volumineuse'), { status: 413, expose: true });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req) {
  const text = await readText(req);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw Object.assign(new Error('JSON invalide'), { status: 400, expose: true });
  }
}

// Démarrage : serveur HTTP + worker d'envoi.
export function start() {
  const db = openDb(config.dbFile);
  if (!config.adminToken || config.adminToken === 'change-me') {
    console.warn('⚠️  ADMIN_TOKEN non défini ou par défaut : changez-le avant la mise en production.');
  }
  const server = createServer(createApp(db));
  server.listen(config.port, () => {
    console.log(`Serveur prêt sur http://localhost:${config.port} ${isDryRun() ? '(mode simulation)' : ''}`);
  });

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const n = await processQueue(db);
      if (n) console.log(`${n} message(s) traité(s)`);
    } catch (err) {
      console.error('Worker :', err);
    } finally {
      running = false;
    }
  }, config.workerIntervalMs);
  return { server, db };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
