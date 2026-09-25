const DEFAULT_WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";
const DEXSCREENER_TOKEN_URL_PREFIX =
  "https://api.dexscreener.com/tokens/v1/solana/";

const JUPITER_MAX_TARGET_MINTS_PER_REQUEST = 49;
const DEXSCREENER_MAX_TOKENS_PER_REQUEST = 30;
const PRICE_FETCH_TIMEOUT_MS = 5000;
const RETRY_DELAYS_MS = [500, 1200];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PRICE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJupiterSolPrices(mints, wrappedSolMint, jupiterApiKey) {
  const uniqueMints = [...new Set((mints || []).filter(Boolean))];
  const prices = new Map();

  if (!jupiterApiKey) {
    console.warn({
      message: "⚠️ JUPITER PRICE PROVIDER UNAVAILABLE",
      reason: "missing_api_key",
    });
    return prices;
  }

  for (
    let offset = 0;
    offset < uniqueMints.length;
    offset += JUPITER_MAX_TARGET_MINTS_PER_REQUEST
  ) {
    const chunk = uniqueMints.slice(
      offset,
      offset + JUPITER_MAX_TARGET_MINTS_PER_REQUEST
    );
    if (!chunk.length) continue;

    const ids = [...new Set([...chunk, wrappedSolMint])];
    let response = null;
    let failed = false;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        response = await fetchWithTimeout(
          `${JUPITER_PRICE_URL}?ids=${encodeURIComponent(ids.join(","))}`,
          {
            method: "GET",
            headers: {
              accept: "application/json",
              "x-api-key": jupiterApiKey,
            },
          }
        );
      } catch (error) {
        if (attempt < RETRY_DELAYS_MS.length) {
          const delayMs = RETRY_DELAYS_MS[attempt];
          console.warn({
            message: "⚠️ JUPITER PRICE RETRY",
            reason: "network_or_timeout",
            attempt: attempt + 1,
            delayMs,
            error: String(error),
          });
          await sleep(delayMs);
          continue;
        }
        console.warn({
          message: "⚠️ JUPITER PRICE PROVIDER ERROR",
          reason: "network_or_timeout",
          error: String(error),
        });
        failed = true;
        break;
      }

      if (response.ok) break;

      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < RETRY_DELAYS_MS.length
      ) {
        const delayMs = RETRY_DELAYS_MS[attempt];
        console.warn({
          message: "⚠️ JUPITER PRICE RETRY",
          reason: response.status === 429 ? "rate_limited" : "upstream_5xx",
          status: response.status,
          attempt: attempt + 1,
          delayMs,
        });
        await sleep(delayMs);
        continue;
      }

      console.warn({
        message: "⚠️ JUPITER PRICE PROVIDER ERROR",
        reason: "http_error",
        status: response.status,
      });
      failed = true;
      break;
    }

    if (failed || !response?.ok) continue;

    try {
      const payload = await response.json();
      const solUsdPrice = Number(payload?.[wrappedSolMint]?.usdPrice);
      if (!Number.isFinite(solUsdPrice) || solUsdPrice <= 0) {
        console.warn({
          message: "⚠️ JUPITER PRICE PROVIDER ERROR",
          reason: "missing_wsol_price",
        });
        continue;
      }

      for (const mint of chunk) {
        const item = payload?.[mint];
        if (!item) continue;

        const tokenUsdPrice = Number(item?.usdPrice);
        if (!Number.isFinite(tokenUsdPrice) || tokenUsdPrice <= 0) continue;

        const priceSOLPerToken = tokenUsdPrice / solUsdPrice;
        if (!Number.isFinite(priceSOLPerToken) || priceSOLPerToken <= 0) continue;

        prices.set(mint, {
          priceSOLPerToken,
          liquidityUSD: Number.isFinite(Number(item?.liquidity))
            ? Number(item.liquidity)
            : 0,
          pairAddress: null,
          dexId: "JUPITER_PRICE_V3",
          url: null,
          source: "JUPITER_PRICE_V3_USD_RATIO",
          tokenUsdPrice,
          solUsdPrice,
          blockId: item?.blockId ?? null,
          createdAt: item?.createdAt ?? null,
        });
      }
    } catch (error) {
      console.warn({
        message: "⚠️ JUPITER PRICE PROVIDER ERROR",
        reason: "invalid_json",
        error: String(error),
      });
    }
  }

  return prices;
}

function selectBestSolQuotedPair(pairs, mint, wrappedSolMint) {
  let best = null;
  for (const pair of pairs) {
    if (pair?.chainId !== "solana") continue;
    if (pair?.baseToken?.address !== mint) continue;
    if (pair?.quoteToken?.address !== wrappedSolMint) continue;

    const priceSOLPerToken = Number(pair?.priceNative);
    const liquidityUSD = Number(pair?.liquidity?.usd || 0);
    if (!Number.isFinite(priceSOLPerToken) || priceSOLPerToken <= 0) continue;

    if (!best || liquidityUSD > best.liquidityUSD) {
      best = {
        priceSOLPerToken,
        liquidityUSD: Number.isFinite(liquidityUSD) ? liquidityUSD : 0,
        pairAddress: pair?.pairAddress || null,
        dexId: pair?.dexId || null,
        url: pair?.url || null,
        source: "DEXSCREENER_SOL_QUOTE",
      };
    }
  }
  return best;
}

async function fetchDexScreenerSolPrices(mints, wrappedSolMint) {
  const uniqueMints = [...new Set((mints || []).filter(Boolean))];
  const prices = new Map();

  for (
    let offset = 0;
    offset < uniqueMints.length;
    offset += DEXSCREENER_MAX_TOKENS_PER_REQUEST
  ) {
    const chunk = uniqueMints.slice(
      offset,
      offset + DEXSCREENER_MAX_TOKENS_PER_REQUEST
    );
    if (!chunk.length) continue;

    let response = null;
    let failed = false;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        response = await fetchWithTimeout(
          `${DEXSCREENER_TOKEN_URL_PREFIX}${chunk.join(",")}`,
          { method: "GET", headers: { accept: "application/json" } }
        );
      } catch (error) {
        if (attempt < RETRY_DELAYS_MS.length) {
          const delayMs = RETRY_DELAYS_MS[attempt];
          console.warn({
            message: "⚠️ DEXSCREENER RETRY",
            reason: "network_or_timeout",
            attempt: attempt + 1,
            delayMs,
            error: String(error),
          });
          await sleep(delayMs);
          continue;
        }
        console.warn({
          message: "⚠️ DEXSCREENER PRICE PROVIDER ERROR",
          reason: "network_or_timeout",
          error: String(error),
        });
        failed = true;
        break;
      }

      if (response.ok) break;

      if (response.status === 429) {
        console.warn({
          message: "⚠️ DEXSCREENER RATE LIMITED",
          status: response.status,
          behavior: "position_without_price_will_be_skipped",
        });
        failed = true;
        break;
      }

      if (response.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
        const delayMs = RETRY_DELAYS_MS[attempt];
        console.warn({
          message: "⚠️ DEXSCREENER RETRY",
          reason: "upstream_5xx",
          status: response.status,
          attempt: attempt + 1,
          delayMs,
        });
        await sleep(delayMs);
        continue;
      }

      console.warn({
        message: "⚠️ DEXSCREENER PRICE PROVIDER ERROR",
        reason: "http_error",
        status: response.status,
      });
      failed = true;
      break;
    }

    if (failed || !response?.ok) continue;

    try {
      const payload = await response.json();
      const pairs = Array.isArray(payload) ? payload : [];
      for (const mint of chunk) {
        const best = selectBestSolQuotedPair(pairs, mint, wrappedSolMint);
        if (best) prices.set(mint, best);
      }
    } catch (error) {
      console.warn({
        message: "⚠️ DEXSCREENER PRICE PROVIDER ERROR",
        reason: "invalid_json",
        error: String(error),
      });
    }
  }

  return prices;
}

export async function fetchPaperExitSolPrices(
  mints,
  {
    wrappedSolMint = DEFAULT_WRAPPED_SOL_MINT,
    jupiterApiKey = null,
  } = {}
) {
  const uniqueMints = [...new Set((mints || []).filter(Boolean))];
  const merged = new Map();

  let jupiterPrices = new Map();
  try {
    jupiterPrices = await fetchJupiterSolPrices(
      uniqueMints,
      wrappedSolMint,
      jupiterApiKey
    );
  } catch (error) {
    console.warn({
      message: "⚠️ JUPITER PRICE PROVIDER ERROR",
      reason: "unexpected_exception",
      error: String(error),
    });
  }

  for (const [mint, priceInfo] of jupiterPrices.entries()) {
    merged.set(mint, priceInfo);
  }

  const missingAfterJupiter = uniqueMints.filter((mint) => !merged.has(mint));

  if (missingAfterJupiter.length) {
    let dexPrices = new Map();
    try {
      dexPrices = await fetchDexScreenerSolPrices(
        missingAfterJupiter,
        wrappedSolMint
      );
    } catch (error) {
      console.warn({
        message: "⚠️ DEXSCREENER PRICE PROVIDER ERROR",
        reason: "unexpected_exception",
        error: String(error),
      });
    }

    for (const [mint, priceInfo] of dexPrices.entries()) {
      if (!merged.has(mint)) merged.set(mint, priceInfo);
    }
  }

  console.log({
    message: "💹 PAPER PRICE PROVIDERS",
    requested: uniqueMints.length,
    jupiterPriced: [...merged.values()].filter(
      (item) => item?.source === "JUPITER_PRICE_V3_USD_RATIO"
    ).length,
    dexScreenerPriced: [...merged.values()].filter(
      (item) => item?.source === "DEXSCREENER_SOL_QUOTE"
    ).length,
    missing: uniqueMints.filter((mint) => !merged.has(mint)).length,
  });

  return merged;
}
