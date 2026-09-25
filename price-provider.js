const DEFAULT_WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

const DEXSCREENER_TOKEN_URL_PREFIX =
  "https://api.dexscreener.com/tokens/v1/solana/";

const GECKOTERMINAL_TOKEN_PRICE_URL_PREFIX =
  "https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/";

const DEXSCREENER_MAX_TOKENS_PER_REQUEST = 30;
const GECKOTERMINAL_MAX_TOKENS_PER_REQUEST = 29;
const PRICE_FETCH_TIMEOUT_MS = 5000;
const RETRY_DELAYS_MS = [500, 1200];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PRICE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function selectBestSolQuotedPair(pairs, mint, wrappedSolMint) {
  let best = null;

  for (const pair of pairs) {
    if (pair?.chainId !== "solana") continue;
    if (pair?.baseToken?.address !== mint) continue;
    if (pair?.quoteToken?.address !== wrappedSolMint) continue;

    const priceSOLPerToken = Number(pair?.priceNative);
    const liquidityUSD = Number(pair?.liquidity?.usd || 0);

    if (!Number.isFinite(priceSOLPerToken) || priceSOLPerToken <= 0) {
      continue;
    }

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
          {
            method: "GET",
            headers: { accept: "application/json" },
          }
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
          fallback: "GECKOTERMINAL",
        });

        failed = true;
        break;
      }

      if (
        response.status >= 500 &&
        attempt < RETRY_DELAYS_MS.length
      ) {
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
        const best = selectBestSolQuotedPair(
          pairs,
          mint,
          wrappedSolMint
        );

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

async function fetchGeckoTerminalSolPrices(mints, wrappedSolMint) {
  const uniqueMints = [...new Set((mints || []).filter(Boolean))];
  const prices = new Map();

  for (
    let offset = 0;
    offset < uniqueMints.length;
    offset += GECKOTERMINAL_MAX_TOKENS_PER_REQUEST
  ) {
    const chunk = uniqueMints.slice(
      offset,
      offset + GECKOTERMINAL_MAX_TOKENS_PER_REQUEST
    );

    if (!chunk.length) continue;

    const addresses = [...new Set([...chunk, wrappedSolMint])];

    let response;

    try {
      response = await fetchWithTimeout(
        `${GECKOTERMINAL_TOKEN_PRICE_URL_PREFIX}${addresses.join(",")}`,
        {
          method: "GET",
          headers: {
            accept: "application/json;version=20230203",
          },
        }
      );
    } catch (error) {
      console.warn({
        message: "⚠️ GECKOTERMINAL PRICE PROVIDER ERROR",
        reason: "network_or_timeout",
        error: String(error),
      });

      continue;
    }

    if (!response.ok) {
      console.warn({
        message: "⚠️ GECKOTERMINAL PRICE PROVIDER ERROR",
        reason: "http_error",
        status: response.status,
      });

      continue;
    }

    try {
      const payload = await response.json();
      const tokenPrices =
        payload?.data?.attributes?.token_prices || {};

      const solUsdPrice = Number(
        tokenPrices?.[wrappedSolMint]
      );

      if (!Number.isFinite(solUsdPrice) || solUsdPrice <= 0) {
        console.warn({
          message: "⚠️ GECKOTERMINAL PRICE PROVIDER ERROR",
          reason: "missing_wsol_price",
        });

        continue;
      }

      for (const mint of chunk) {
        const tokenUsdPrice = Number(tokenPrices?.[mint]);

        if (
          !Number.isFinite(tokenUsdPrice) ||
          tokenUsdPrice <= 0
        ) {
          continue;
        }

        const priceSOLPerToken =
          tokenUsdPrice / solUsdPrice;

        if (
          !Number.isFinite(priceSOLPerToken) ||
          priceSOLPerToken <= 0
        ) {
          continue;
        }

        prices.set(mint, {
          priceSOLPerToken,
          liquidityUSD: 0,
          pairAddress: null,
          dexId: "GECKOTERMINAL",
          url: null,
          source: "GECKOTERMINAL_USD_RATIO",
          tokenUsdPrice,
          solUsdPrice,
        });
      }
    } catch (error) {
      console.warn({
        message: "⚠️ GECKOTERMINAL PRICE PROVIDER ERROR",
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
  } = {}
) {
  const uniqueMints =
    [...new Set((mints || []).filter(Boolean))];

  const merged = new Map();

  let dexPrices = new Map();

  try {
    dexPrices = await fetchDexScreenerSolPrices(
      uniqueMints,
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
    merged.set(mint, priceInfo);
  }

  const missing = uniqueMints.filter(
    (mint) => !merged.has(mint)
  );

  if (missing.length) {
    let fallbackPrices = new Map();

    try {
      fallbackPrices = await fetchGeckoTerminalSolPrices(
        missing,
        wrappedSolMint
      );
    } catch (error) {
      console.warn({
        message: "⚠️ GECKOTERMINAL PRICE PROVIDER ERROR",
        reason: "unexpected_exception",
        error: String(error),
      });
    }

    for (const [mint, priceInfo] of fallbackPrices.entries()) {
      if (!merged.has(mint)) {
        merged.set(mint, priceInfo);
      }
    }
  }

  console.log({
    message: "💹 PAPER PRICE PROVIDERS",
    requested: uniqueMints.length,
    dexScreenerPriced: [...merged.values()].filter(
      (item) => item?.source === "DEXSCREENER_SOL_QUOTE"
    ).length,
    geckoTerminalPriced: [...merged.values()].filter(
      (item) => item?.source === "GECKOTERMINAL_USD_RATIO"
    ).length,
    missing: uniqueMints.filter(
      (mint) => !merged.has(mint)
    ).length,
  });

  return merged;
}
