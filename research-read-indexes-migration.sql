-- Apply after D1 daily read quota resets. No detector or accounting changes.
CREATE INDEX IF NOT EXISTS immediate_success_time
  ON paper_immediate_entry_checks(buy_executable,checked_at,source_signature);
CREATE INDEX IF NOT EXISTS research_open_order
  ON paper_research_positions(status,COALESCE(last_checked_at,admitted_at),admitted_at,source_signature);
CREATE INDEX IF NOT EXISTS quote_research_open_order
  ON paper_quote_research_positions(status,(last_checked_at IS NOT NULL),last_checked_at,admitted_at,source_signature);
