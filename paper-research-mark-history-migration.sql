-- Additive history only; historical mark values cannot be reconstructed.
CREATE TABLE IF NOT EXISTS paper_research_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_signature TEXT NOT NULL,
  position_revision INTEGER NOT NULL,
  feed_started_at TEXT NOT NULL,
  feed_completed_at TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  mark_price_sol REAL,
  mark_source TEXT,
  highest_price_sol REAL NOT NULL,
  planned_exit_reason TEXT,
  quote_budget_available INTEGER NOT NULL,
  observation_reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_mark_timeline
  ON paper_research_marks(source_signature,checked_at);
