# GAKE_TRADER_BOT — laptop-first operating plan
Decision: 2026-10-12, user-authorized simplification.

Use the existing Windows laptop price publisher and project-local supervisor. Keep the existing Cloudflare Paper Worker, Helius webhook, D1 and Google Drive archive. Do not add another server, VPS or permanent Netlify feed. This is not a migration of the working Worker to Windows.

Success means sustainable net realized Paper PnL after fees, slippage and failed exits, with open inventory and drawdown accounted for. A working feed or isolated winning trades cannot establish profitability. Detector logic, captured risk settings, execution=DISABLED and realMoney=false remain fixed.

The host publisher keeps one coherent provider response per 30-second tick, capped at 29 token mints plus SOL. All Main mints have first priority, then research mints ordered like the existing fair observation queue. Larger research populations rotate through the batch. No Worker scheduling changes, extra provider calls, mixed-price snapshots or fresh timestamps on old data are introduced. 30 or more Main mints fail closed; missing provider prices remain unavailable and existing fallbacks apply. Sudden admissions between snapshots are not guaranteed immediate host coverage.

START_GAKE_PAPER.cmd at the project root starts the existing guarded launcher. It checks locks and process identities and does not create duplicate publishers. After reboot or total process exit, run it manually. The laptop must be running and connected for this host feed; the current supervisor is not a Windows service or autostart task. Check publisher.json actual successes/freshness, not only supervisor RUNNING.

Credentials stay in existing project-local authenticated configuration and service secret bindings. Use them in place; archive references and required setup only, never secret values. No secret copies into chat, source control, reports or shared archives.

Next: restore and verify a fresh laptop feed, review new admissions and actual sell-quote failures, then use a future Paper cohort with a shared cash budget and net PnL. Keep infrastructure work tied to a demonstrated trading or reliability problem.
