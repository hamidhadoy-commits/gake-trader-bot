CREATE TABLE IF NOT EXISTS paper_cron_queue_runs (
  id TEXT PRIMARY KEY,
  scheduled_time INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
