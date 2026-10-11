# Paper fast observation experiment — candidate, not activated

The production Worker does not import paper-observation-scheduler.mjs.
Its pure selector reserves up to two of four observation slots for positions
admitted in the last 15 minutes; other slots rotate oldest checks. No additional
queue messages, changes to detectors, or changes to captured exit risk rules.

In a stable 22-position scenario with two young positions, selection simulation
revisits both young positions every 60 seconds and all 20 older positions within
10 minutes. This moves capacity from old positions; it does not make all exits
faster. Quote research may need a second quote for a TP slice, so four quote
requests cannot guarantee four position observations or any exit execution.
Mark research still has its distinct two-quote budget.

Read-only shadow at 2026-10-11T11:33:51Z found Mark=20 and Quote=22 open,
zero entries within 15 minutes; youngest entry about 15.67 hours old.
It cannot validate faster observation or profitability of fresh entries.
Active Worker remained baseline 39b9dbeb-2cac-4b32-a276-d3957fa2edd4 at 100%.
Shadow snapshot: .gake-tools/host-feed-oct09/paper-observation-scheduler-shadow-oct11.json.

Next concrete implementation:
- Keep the original cohorts and account intact; record scheduler version and
  separate future treatment results before comparing historical PnL.
- Validate bounded DB selection: recent LIMIT 2 plus fair LIMIT 4, union by
  signature; never load unbounded positions in the production Worker.
- Test captured risk config, partial TP quote consumption, stale position
  revisions, new arrivals exceeding reserved capacity, and provider failures.
- Profile the full Worker with D1 and route calls before deployment; standalone
  Node test duration is not Cloudflare CPU evidence.
- A finite, journalled Paper canary must establish actual revisit times for new
  entries, no stale feed, unchanged exact exit amounts, and resource ceilings.
  If no new eligible entries arrive, record NO_NEW_ENTRY_EVIDENCE, not success.
- Compare next fresh entries prospectively using the same time window and
  explicit inventory valuation. Do not infer profitable fills from quotes.
- Roll back on unhealthy cycles, stale observations, resource overruns or risk
  config mismatch. Identify the active Worker and Windows processes first.

Resource basis verified 2026-10-11:
One existing message/minute is approximately 4320 Queue operations/day
for sub-64KB messages with no retries. Five messages/minute would be 21600,
above Free 10000/day. No extra messages or paid plan have been enabled.
Source: https://developers.cloudflare.com/queues/platform/pricing/
D1 prior-day 86356/100000 writes is existing evidence, not new daily usage.
Fresh Netlify compute billing and full-cycle profiling remain outstanding.

execution=DISABLED; realMoney=false; no signing or real trading.

## Integration update — 2026-10-11
Mark research now imports the bounded loader. The caller defaults to null, so
production activation still requires an explicit finite startsAtMs/endsAtMs.
Windows are at most one hour and stop at the exclusive end boundary.
Trial observations record scheduler version/window alongside response metadata.
Both selection queries use research_open_order. Actual recent query: 20 rows
read, 0 written, SQL duration 0.2345ms on the 20-position snapshot.
60 selected tests passed, including finite boundaries, exact partial TP,
two-quote cap, unavailable routes, frozen entry config and default fallback.
Full local Worker ran main/Quote/Mark plus queue completion on a copied
3/22/20-open-position fixture. Two admission timestamps were synthetic.
Four controlled ticks, including expiry, passed; account and risk unchanged.
External prices were mocked unavailable: this validates failure behavior, not
profitable fills or valid-price full-cycle CPU. Local wall time is not live CPU.
Isolated simulator upgraded to Miniflare 5.20261006.1-alpha/workerd 1.20261006.1;
compatibilityDate stayed 2026-09-10; production dependencies were not changed.
