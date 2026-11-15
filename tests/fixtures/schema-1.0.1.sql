-- Frozen schema from Material Finder 1.0.1; compatibility fixture.
PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contents (
        hash TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued', error TEXT,
        extracted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        size INTEGER NOT NULL, mtime REAL NOT NULL,
        hash TEXT NOT NULL REFERENCES contents(hash)
      );
      CREATE INDEX IF NOT EXISTS sources_hash ON sources(hash);
      CREATE TABLE IF NOT EXISTS units (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_hash TEXT NOT NULL REFERENCES contents(hash) ON DELETE CASCADE,
        unit_key TEXT NOT NULL, ordinal INTEGER NOT NULL, locator TEXT NOT NULL,
        text TEXT NOT NULL, spans TEXT NOT NULL, width REAL, height REAL, image_path TEXT,
        needs_ocr INTEGER NOT NULL, ocr_error TEXT, confidence REAL,
        normalized TEXT NOT NULL, offsets TEXT NOT NULL,
        UNIQUE(content_hash, unit_key)
      );
      CREATE INDEX IF NOT EXISTS units_content ON units(content_hash, ordinal);
      CREATE INDEX IF NOT EXISTS units_search_text ON units(normalized, content_hash, ordinal);
      CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(
        normalized, content='units', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS units_insert AFTER INSERT ON units BEGIN
        INSERT INTO units_fts(rowid, normalized) VALUES (new.id,new.normalized);
      END;
      CREATE TRIGGER IF NOT EXISTS units_delete AFTER DELETE ON units BEGIN
        INSERT INTO units_fts(units_fts,rowid,normalized) VALUES ('delete',old.id,old.normalized);
      END;
      CREATE TRIGGER IF NOT EXISTS units_update AFTER UPDATE ON units BEGIN
        INSERT INTO units_fts(units_fts,rowid,normalized) VALUES ('delete',old.id,old.normalized);
        INSERT INTO units_fts(rowid,normalized) VALUES (new.id,new.normalized);
      END;
