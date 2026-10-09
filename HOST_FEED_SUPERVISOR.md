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
