# Host feed process recovery
A project-local Node supervisor restarts the existing price publisher after process exit, with bounded 5–60 second backoff. It records exit code/signal and a 30-second supervisor heartbeat. Child stderr is discarded; only a boolean records its occurrence, so credentials and response bodies are not copied into the checkpoint.

Start from the existing publisher-process.json checkpoint after confirming its publisher PID is absent:
node start-host-reference-supervisor.mjs --state-dir <absolute host-feed checkpoint directory>

The launcher refuses a live standalone publisher. The supervisor lock prevents two supervisors for the same checkpoint. The publisher's existing lock independently prevents two price publishers. Stale locks are reclaimed only when their PID is absent; a reused PID fails closed.
Read supervisor.json for the current childPid; publisher-process.json is now the historical input record, not the active child PID. Read publisher.json for actual feed success, freshness and provider errors; supervisor RUNNING alone does not establish a fresh feed.

No Windows service, Task Scheduler entry, startup registration, system setting, Worker runtime, provider priority, freshness policy, detector, risk setting, or trading execution change is included. The supervisor does not restart a still-running child with API failures, and cannot survive shutdown, loss of the supervisor itself, or reboot. Manual startup is still required after these cases. Free API/D1 use follows the same 30-second publisher cadence.

Stop by checking supervisor-process.json PID identity, then terminate that supervisor and its current child from supervisor.json. Windows force termination can leave lock files; both locks remain fail-closed until their recorded PIDs are gone. Roll back by stopping both processes, then run the original publisher using its saved args.
Tests use local fixture children without provider calls: restart after nonzero exit, duplicate supervisor rejection, stop/lock cleanup, bounded crash-loop termination and suppression of stderr content. Existing host feed tests verify freshness and unchanged fallbacks.

Repeated launch while the supervisor lock PID is alive returns supervisorAlreadyRunning without replacing config or process metadata. Invalid lock content fails closed. This is a manual launcher; it does not install startup tasks or survive a computer shutdown automatically.

## Laptop transient recovery (2026-10-12)
The guarded launcher now adds --recover-transient to the publisher. After the first two retry waits (30/60 seconds), request, rate-limit, HTTP/database-request and auth-refresh failures retry after 5/10/15 minutes, capped at 15 minutes. Total recovery attempts are not capped; their frequency is capped. Success resets the consecutive-failure budget and returns to the existing 30-second cadence. Data/configuration failures still stop after three failures; default runFeedLoop and one-off publishers keep the finite policy. A recovery wait is interruptible by SIGINT/SIGTERM. No stale snapshot is republished during failure; the existing 90-second decoder rejects old data. This still cannot survive a laptop shutdown or supervisor termination; START_GAKE_PAPER.cmd remains the manual launcher.
