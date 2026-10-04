-- Apply once before deploying the observation metadata change.
-- Existing rows remain NULL; no historical prices are inferred.
ALTER TABLE paper_immediate_entry_checks ADD COLUMN sol_usd_price REAL;
ALTER TABLE paper_immediate_entry_checks ADD COLUMN sol_usd_source TEXT;
