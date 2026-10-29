import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS contacts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone       TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL DEFAULT '',
      tags        TEXT NOT NULL DEFAULT '',
      data        TEXT NOT NULL DEFAULT '{}',
      opted_out   INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS templates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      wa_name     TEXT NOT NULL,
      language    TEXT NOT NULL DEFAULT 'fr',
      body        TEXT NOT NULL,
      params      TEXT NOT NULL DEFAULT '[]',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      template_id  INTEGER NOT NULL REFERENCES templates(id),
      tag          TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'scheduled',
      scheduled_at INTEGER NOT NULL,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id   INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      contact_id    INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      phone         TEXT NOT NULL,
      params        TEXT NOT NULL DEFAULT '[]',
      body          TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'queued',
      wa_message_id TEXT,
      attempts      INTEGER NOT NULL DEFAULT 0,
      error         TEXT,
      updated_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_queue ON messages(status, campaign_id);
    CREATE INDEX IF NOT EXISTS idx_messages_wa ON messages(wa_message_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_tags ON contacts(tags);
  `);
  return db;
}
