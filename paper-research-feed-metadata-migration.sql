CREATE TABLE IF NOT EXISTS paper_research_feed_metadata (
  source_signature TEXT NOT NULL,
  position_revision INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  mark_source TEXT,
  response_metadata_json TEXT,
  PRIMARY KEY (source_signature, position_revision, checked_at)
);
