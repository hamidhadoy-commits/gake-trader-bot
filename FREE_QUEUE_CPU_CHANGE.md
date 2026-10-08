# Free Queue CPU change
The minute cron enqueues one message. A Queue consumer with batch size 1 and concurrency 1 runs the same full paper pipeline, in the original order. Execution remains DISABLED and realMoney=false.

Source baseline was reconstructed from the active deployment 10329bdd-fd66-4e4f-b946-6766e1727113. Esbuild output, with whitespace and comments normalized, matches that active runtime exactly before adding the Queue wrapper.

No detector, position sizing, exit thresholds, fee, slippage, quote budget, secret, Helius setting or HTTP handler change is included.

## Delivery and failure behavior
The new paper_cron_queue_runs table claims each scheduled timestamp once. Duplicate deliveries cannot replay a completed or partially completed cycle. An error after a claim leaves STARTED and acknowledges that message; the next minute has a new claim, matching the original cron's next-cycle recovery rather than replaying partial accounting. Retries are zero. A D1 failure before claiming leaves the message unacknowledged; the configured zero retries means that minute can be lost, as when the original cron cannot access D1. Queue delivery latency can delay a cycle; backlog and completion status must be monitored.

One message per minute normally uses 4,320 Queue operations/day, within the documented free allowance of 10,000/day. Other account workloads also consume that allowance. No paid plan is enabled.

Live synthetic stress revealed a roughly 50ms CPU cutoff for Queue deliveries on this account, rather than the 30-second default quoted generically in Queue documentation. This is an observed account-specific cutoff, not a contractual limit or unlimited-CPU guarantee. Keep ordinary complete cycles below it.

## Validation
Seven Queue behavior tests pass. Native Queue/D1 tests compare all 23 business tables with the original cycle (execution timestamps normalized) and verify invalid messages, duplicate delivery, a COMPLETE durable claim, and a cron-produced duplicate. Real provider HTTP is fully mocked in those tests.

The reconstructed active baseline passes 138/139 existing tests; the candidate passes 145/146 including seven new tests. The same pre-existing failure in both is "concurrent starts remain 1100ms apart" in jupiter-pacing.test.mjs. The current deployed provider deliberately lacks the Promise-chain gate present in Git HEAD after recovery from CPU interruption. This change preserves that deployed provider; it does not resolve the separate concurrency pacing expectation.

Apply paper-cron-queue.sql without destructive migrations before deployment. Create gake-paper-cron-free, upload with --keep-vars, deploy the new version, attach the consumer, and monitor real completions and CPU. Roll back to the previous version and detach/delete the new queue if real cycles fail or exceed the observed cutoff. Leave historical claim rows intact on rollback.
