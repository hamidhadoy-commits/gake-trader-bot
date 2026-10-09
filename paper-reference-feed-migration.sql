CREATE TABLE IF NOT EXISTS paper_reference_price_feed (
  id INTEGER PRIMARY KEY CHECK(id=1),
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
