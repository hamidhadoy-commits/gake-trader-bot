# Free mark-price recovery

CoinGecko remains primary. Missing marks use the official public GeckoTerminal simple endpoint before Jupiter and DEXScreener. No credential is sent there. Up to 29 target tokens plus wrapped SOL per request; positive finite token/SOL ratio from the same response. Distinct source and transport metadata retained. Reference prices never replace executable sale quotes.

429 responses record fixed sanitized categories and Retry-After only. Independent isolate-local cooldown: at least 60 seconds, one hour for monthly-credit errors, longer if Retry-After requires. No waiting, stale prices, new D1 writes, same-job retry, account change or paid subscription. Suppression is best effort across restarts/isolates.

152 tests passed. Live host probe priced all 13 open Mark tokens. Live Worker verification follows with rollback on failure. Risk, detectors and configuration unchanged.

Official docs: https://apiguide.geckoterminal.com/ and https://apiguide.geckoterminal.com/faq . Beta public API with 30 calls/minute limit.
