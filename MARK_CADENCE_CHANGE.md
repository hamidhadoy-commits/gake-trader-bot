# Faster Mark Research sampling on the Free Queue path

Mark Research now checks up to four positions per one-minute Queue job, up from two. Its executable sell-quote budget remains two; Quote Research remains four quotes. For 13 stable open Mark positions, the ideal average mark interval changes from 390 to 195 seconds. This does not promise an executable exit or increase sell capacity when many positions trigger together.

No risk thresholds, detectors, fees, sizing, accounting rules, Queue settings, secrets or execution mode change. One message per minute still normally uses 4,320 Queue operations/day; Free allowance is shared across the account.

Validation: 147 existing tests pass; nine fresh native actual-runtime scenarios pass with duplicate/accounting checks; 27 isolated Free Queue cases complete with positive reference prices and synthetic unavailable/available sale routes. All external application requests in the experiment are mocked. Recorded four-position CPU times (three runs per mode):

- NO_TRIGGER: 41ms; 0 synthetic exits
- NO_TRIGGER: 39ms; 0 synthetic exits
- NO_TRIGGER: 38ms; 0 synthetic exits
- EXIT_BLOCKED: 21ms; 0 synthetic exits
- EXIT_BLOCKED: 21ms; 0 synthetic exits
- EXIT_BLOCKED: 20ms; 0 synthetic exits
- EXIT_AVAILABLE: 23ms; 2 synthetic exits
- EXIT_AVAILABLE: 21ms; 2 synthetic exits
- EXIT_AVAILABLE: 22ms; 2 synthetic exits

Short synthetic measurements are not a guarantee for all production branches, provider behavior or profitability. Production rollout requires completion, CPU and accounting observation and retains the prior active version for rollback.
