CREATE TABLE IF NOT EXISTS paper_shared_accounts (
 id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('ACTIVE','PAUSED')),
 starts_at TEXT NOT NULL, entries_until TEXT NOT NULL,
 initial_usd REAL NOT NULL, initial_sol_usd REAL NOT NULL, initial_lamports INTEGER NOT NULL,
 cash_lamports INTEGER NOT NULL CHECK(cash_lamports>=0), realized_pnl_lamports INTEGER NOT NULL DEFAULT 0,
 fees_lamports INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
 config_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_shared_positions (
 run_id TEXT NOT NULL, source_signature TEXT NOT NULL, mint TEXT NOT NULL,
 detector TEXT NOT NULL, confidence TEXT NOT NULL,
 initial_raw_amount TEXT NOT NULL, remaining_raw_amount TEXT NOT NULL, decimals INTEGER NOT NULL,
 input_lamports INTEGER NOT NULL, entry_cost_lamports INTEGER NOT NULL,
 entry_price_sol REAL NOT NULL, highest_price_sol REAL NOT NULL,
 take_profit_hit INTEGER NOT NULL DEFAULT 0, allocated_cost_lamports INTEGER NOT NULL DEFAULT 0,
 modeled_proceeds_lamports INTEGER NOT NULL DEFAULT 0, modeled_pnl_lamports INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('PAPER_OPEN','PAPER_CLOSED')),
 opened_at TEXT NOT NULL,last_checked_at TEXT,last_quote_at TEXT,last_quote_raw TEXT,last_quote_out INTEGER,last_quote_reason TEXT,
 closed_at TEXT,close_reason TEXT,config_json TEXT NOT NULL,
 PRIMARY KEY(run_id,source_signature), FOREIGN KEY(run_id) REFERENCES paper_shared_accounts(id)
);
CREATE INDEX IF NOT EXISTS paper_shared_open_order ON paper_shared_positions(run_id,status,last_checked_at,opened_at);
CREATE TABLE IF NOT EXISTS paper_shared_ledger (
 operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,source_signature TEXT,
 event_type TEXT NOT NULL CHECK(event_type IN ('INITIAL','BUY','SELL','SKIP','MARK')),
 account_revision INTEGER NOT NULL,position_revision INTEGER,
 cash_delta_lamports INTEGER NOT NULL,pnl_delta_lamports INTEGER NOT NULL DEFAULT 0,
 fee_lamports INTEGER NOT NULL DEFAULT 0,allocated_cost_lamports INTEGER NOT NULL DEFAULT 0,
 raw_amount TEXT,quote_out_lamports INTEGER,reason TEXT,checked_at TEXT NOT NULL,
 FOREIGN KEY(run_id) REFERENCES paper_shared_accounts(id)
);
CREATE INDEX IF NOT EXISTS paper_shared_ledger_run ON paper_shared_ledger(run_id,checked_at);
