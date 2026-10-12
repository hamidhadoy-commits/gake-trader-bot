# Shared-cash Paper trial ($20)
Run id: PAPER_CASH_20USD_20261012_V1. Paper only: execution=DISABLED, realMoney=false.

The new account is isolated in paper_shared_* tables. Legacy Main accounts, positions, exits and research history are retained. Only detector-matched immediate observations checked after the run start and within 120 seconds can enter; old entries are not replayed.

Initial capital is exactly $20 converted to SOL at initialization from the existing fresh, cache-age-validated laptop SOL/USD snapshot (floor to whole lamports). The captured Main risk config remains: 25% equity sizing, 50% exposure, maximum 3 open positions, $1/$10 trade limits, 10% buy/15% sell conservative modeling, 0.0015/0.002 SOL fees, SL -15%, TP +40% sells 30%, TSL 20%. Buy holdings are quote raw output divided by 1.10, floored; selling uses quoted SOL output times 0.85, floored, less fee. This is modeled Paper accounting, not a fill guarantee.

Entries are allowed for 24 hours from starts_at. After entries_until, no new entries are accepted, but open positions continue to be managed. PAUSED stops this account. Manual pause must increment account revision to invalidate in-flight operations; pausing does not fabricate exits.

The existing QUOTE_RESEARCH phase shares four request units between the new account and old Quote research. New account exits have priority. One exact buy reserves two units for token-decimal lookup and order; each exact sell reserves one. Old Quote research gets the unused units. Mark research's four marks/two sell quotes and the old Main exit phase stay unchanged. Provider helper retries remain as before. No extra cron, queue message, server, signing or secret export is added.

Cash, PnL, quantity and fee changes are atomic D1 batches guarded by account/position revision and unique ledger operations. Duplicate operations cannot spend twice. No-route, stale quote, lack of cash or exposure, and missing SOL/USD do not create positions or proceeds. A partial exit invalidates the old remaining quote. Reporting reconciles all ledger cash and quantities; open liquidation equity is unknown unless exact remaining quotes within 90 seconds exist. Drawdown is only over observed valid quotes and is labeled as incomplete where observations are missing.

No old Main reset, forced liquidation or liquidity assumption is part of this run. A fresh account is a new experiment; losses and blocked positions in the old account remain visible. Profitability requires later exits and enough independent observations; a positive quote estimate is not a sustained-profit claim.
