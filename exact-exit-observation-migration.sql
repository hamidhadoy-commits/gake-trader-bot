-- Additive observation only; never modifies historical probes or paper balances.
CREATE TABLE IF NOT EXISTS paper_exact_entry_exit_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_signature TEXT NOT NULL,
  mint TEXT NOT NULL,
  age_bucket TEXT NOT NULL CHECK (age_bucket IN ('M1','M3','M5','M10')),
  entry_checked_at TEXT NOT NULL,
  quote_started_at TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  age_seconds REAL NOT NULL,
  input_raw_amount TEXT NOT NULL,
  token_decimals INTEGER NOT NULL,
  target_copy_lamports INTEGER NOT NULL,
  buy_fee_lamports INTEGER NOT NULL,
  sell_fee_lamports INTEGER NOT NULL,
  fee_basis TEXT NOT NULL,
  executable INTEGER NOT NULL,
  definitive INTEGER NOT NULL,
  reason TEXT NOT NULL,
  http_status INTEGER,
  out_lamports INTEGER,
  net_lamports INTEGER,
  net_pct REAL,
  router TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS exact_entry_exit_definitive
  ON paper_exact_entry_exit_checks(source_signature, age_bucket)
  WHERE definitive = 1;
CREATE INDEX IF NOT EXISTS exact_entry_exit_attempts
  ON paper_exact_entry_exit_checks(source_signature, checked_at);
