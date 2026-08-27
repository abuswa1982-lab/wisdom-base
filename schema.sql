-- Wisdom Base storage. Run once against your D1 database.

CREATE TABLE IF NOT EXISTS records (
  id        TEXT PRIMARY KEY,
  dept      TEXT NOT NULL,
  topic     TEXT NOT NULL,
  scenario  TEXT NOT NULL,
  trigger   TEXT,
  aliases   TEXT,           -- json array
  inputs    TEXT,           -- json array
  rules     TEXT,           -- json array
  status    TEXT NOT NULL DEFAULT 'draft',   -- draft | approved
  owner     TEXT,
  updated   TEXT,
  updated_by TEXT
);

-- one scenario per path, enforced by the database and not just the UI
CREATE UNIQUE INDEX IF NOT EXISTS records_path
  ON records (lower(dept), lower(topic), lower(scenario));

CREATE INDEX IF NOT EXISTS records_status ON records (status);

-- questions nobody had an answer for: the build queue
CREATE TABLE IF NOT EXISTS gaps (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  asked_by TEXT,
  asked_at TEXT
);

-- what got looked up, so you can prove escalations went down
CREATE TABLE IF NOT EXISTS lookups (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT,
  scenario  TEXT,
  who       TEXT,
  at        TEXT
);

CREATE INDEX IF NOT EXISTS lookups_at ON lookups (at);
