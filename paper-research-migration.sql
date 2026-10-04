-- Isolated research book. No writes to paper_copy_* or detector tables.
CREATE TABLE IF NOT EXISTS paper_research_runs (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, scope TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_research_positions (
  source_signature TEXT PRIMARY KEY, run_id TEXT NOT NULL, mint TEXT NOT NULL,
  entry_checked_at TEXT NOT NULL, admitted_at TEXT NOT NULL,
  initial_raw_amount TEXT NOT NULL, remaining_raw_amount TEXT NOT NULL,
  decimals INTEGER NOT NULL, input_lamports INTEGER NOT NULL,
  entry_cost_lamports INTEGER NOT NULL, entry_price_sol REAL NOT NULL,
  config_json TEXT NOT NULL, config_captured_at TEXT NOT NULL,
  highest_price_sol REAL NOT NULL, take_profit_hit INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RESEARCH_OPEN', revision INTEGER NOT NULL DEFAULT 0,
  allocated_cost_lamports INTEGER NOT NULL DEFAULT 0,
  quote_proceeds_lamports INTEGER NOT NULL DEFAULT 0,
  modeled_proceeds_lamports INTEGER NOT NULL DEFAULT 0,
  modeled_pnl_lamports INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT, last_mark_price_sol REAL, last_mark_source TEXT,
  closed_at TEXT, close_reason TEXT
);
CREATE INDEX IF NOT EXISTS research_open_queue
  ON paper_research_positions(status,last_checked_at,admitted_at);
CREATE TABLE IF NOT EXISTS paper_research_exit_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_signature TEXT NOT NULL,
  position_revision INTEGER NOT NULL, exit_reason TEXT NOT NULL,
  input_raw_amount TEXT NOT NULL, mark_price_sol REAL NOT NULL, mark_source TEXT,
  quote_started_at TEXT NOT NULL, checked_at TEXT NOT NULL,
  executable INTEGER NOT NULL, reason TEXT NOT NULL, http_status INTEGER,
  quoted_out_lamports INTEGER, router TEXT
);
CREATE TABLE IF NOT EXISTS paper_research_exits (
  operation_id TEXT PRIMARY KEY, source_signature TEXT NOT NULL,
  position_revision INTEGER NOT NULL, exit_reason TEXT NOT NULL,
  sold_raw_amount TEXT NOT NULL, remaining_raw_amount TEXT NOT NULL,
  quoted_out_lamports INTEGER NOT NULL, sell_haircut_bps INTEGER NOT NULL,
  haircut_lamports INTEGER NOT NULL, sell_fee_lamports INTEGER NOT NULL,
  quote_net_lamports INTEGER NOT NULL, modeled_net_lamports INTEGER NOT NULL,
  allocated_entry_cost_lamports INTEGER NOT NULL, modeled_pnl_lamports INTEGER NOT NULL,
  quote_started_at TEXT NOT NULL, checked_at TEXT NOT NULL, router TEXT
);
