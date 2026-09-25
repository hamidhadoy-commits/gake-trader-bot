const DEFAULT_WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";
const JUPITER_TOKENS_SEARCH_URL = "https://api.jup.ag/tokens/v2/search";
const JUPITER_SWAP_ORDER_URL = "https://api.jup.ag/swap/v2/order";
const DEXSCREENER_TOKEN_URL_PREFIX =
  "https://api.dexscreener.com/tokens/v1/solana/";

const JUPITER_MAX_TARGET_MINTS_PER_REQUEST = 49;
const JUPITER_TOKENS_MAX_MINTS_PER_REQUEST = 100;
const DEXSCREENER_MAX_TOKENS_PER_REQUEST = 30;
const PRICE_FETCH_TIMEOUT_MS = 7000;
const JUPITER_MIN_REQUEST_SPACING_MS = 1100;
const RETRY_DELAYS_MS = [1200];

let lastJupiterRequestStartedAt = 0;

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

async function fetchJupiterWithPacing(url, jupiterApiKey) {
  const now = Date.now();
  const waitMs = Math.max(
    0,
    JUPITER_MIN_REQUEST_SPACING_MS - (now - lastJupiterRequestStartedAt)
  );

  if (waitMs > 0) {
    await sleep(waitMs);
  }

  lastJupiterRequestStartedAt = Date.now();

  return fetchWithTimeout(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-api-key": jupiterApiKey,
    },
  });
}

async function fetchJupiterWithRetry(url, jupiterApiKey, logPrefix) {
  let response = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      response = await fetchJupiterWithPacing(url, jupiterApiKey);
    } catch (error) {
      if (attempt < RETRY_DELAYS_MS.length) {
        const delayMs = RETRY_DELAYS_MS[attempt];
        console.warn({
          message: `⚠️ ${logPrefix} RETRY`,
          reason: "network_or_timeout",
          attempt: attempt + 1,
          delayMs,
          error: String(error),
        });
        await sleep(delayMs);
        continue;
      }

      console.warn({
        message: `⚠️ ${logPrefix} ERROR`,
        reason: "network_or_timeout",
        error: String(error),
      });
      return null;
    }

    if (response.ok) {
      return response;
    }

    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < RETRY_DELAYS_MS.length
    ) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      console.warn({
        message: `⚠️ ${logPrefix} RETRY`,
        reason: response.status === 429 ? "rate_limited" : "upstream_5xx",
        status: response.status,
        attempt: attempt + 1,
        delayMs,
      });
      await sleep(delayMs);
      continue;
    }

    console.warn({
      message: `⚠️ ${logPrefix} ERROR`,
      reason: "http_error",
      status: response.status,
    });
    return null;
  }

  return null;
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
    const response = await fetchJupiterWithRetry(
      `${JUPITER_PRICE_URL}?ids=${encodeURIComponent(ids.join(","))}`,
      jupiterApiKey,
      "JUPITER PRICE PROVIDER"
    );

    if (!response) continue;

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
        if (!Number.isFinite(priceSOLPerToken) || priceSOLPerToken <= 0) {
          continue;
        }

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

async function fetchJupiterTokenDecimals(mints, jupiterApiKey) {
  const uniqueMints = [...new Set((mints || []).filter(Boolean))];
  const decimalsByMint = new Map();

  if (!uniqueMints.length || !jupiterApiKey) {
    return decimalsByMint;
  }

  for (
    let offset = 0;
    offset < uniqueMints.length;
    offset += JUPITER_TOKENS_MAX_MINTS_PER_REQUEST
  ) {
    const chunk = uniqueMints.slice(
      offset,
      offset + JUPITER_TOKENS_MAX_MINTS_PER_REQUEST
    );

    const response = await fetchJupiterWithRetry(
      `${JUPITER_TOKENS_SEARCH_URL}?query=${encodeURIComponent(chunk.join(","))}`,
      jupiterApiKey,
      "JUPITER TOKENS PROVIDER"
    );

    if (!response) continue;

    try {
      const payload = await response.json();
      const items = Array.isArray(payload) ? payload : [];

      for (const item of items) {
        const mint = item?.id || item?.mint || item?.address || null;
        const decimals = Number(item?.decimals);

        if (
          !mint ||
          !Number.isInteger(decimals) ||
          decimals < 0 ||
          decimals > 18
        ) {
          continue;
        }

        decimalsByMint.set(mint, decimals);
      }
    } catch (error) {
      console.warn({
        message: "⚠️ JUPITER TOKENS PROVIDER ERROR",
        reason: "invalid_json",
        error: String(error),
      });
    }
  }

  return decimalsByMint;
}

function humanAmountToRaw(humanAmount, decimals) {
  const amount = Number(humanAmount);

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18
  ) {
    return null;
  }

  const scale = 10 ** decimals;
  const raw = Math.floor(amount * scale);

  if (!Number.isFinite(raw) || raw <= 0) {
    return null;
  }

  return Math.trunc(raw).toString();
}

function getTokenAmountForMint(tokenAmountsByMint, mint) {
  if (tokenAmountsByMint instanceof Map) {
    return Number(tokenAmountsByMint.get(mint) || 0);
  }

  if (tokenAmountsByMint && typeof tokenAmountsByMint === "object") {
    return Number(tokenAmountsByMint[mint] || 0);
  }

  return 0;
}

async function fetchJupiterSwapQuoteSolPrices(
  mints,
  wrappedSolMint,
  jupiterApiKey,
  tokenAmountsByMint
) {
  const uniqueMints = [...new Set((mints || []).filter(Boolean))];
  const prices = new Map();

  if (!uniqueMints.length || !jupiterApiKey) {
    return prices;
  }

  const decimalsByMint = await fetchJupiterTokenDecimals(
    uniqueMints,
    jupiterApiKey
  );

  for (const mint of uniqueMints) {
    const decimals = decimalsByMint.get(mint);
    const humanAmount = getTokenAmountForMint(tokenAmountsByMint, mint);

    if (!Number.isInteger(decimals)) {
      console.warn({
        message: "⚠️ JUPITER SWAP QUOTE UNAVAILABLE",
        mint,
        reason: "missing_token_decimals",
      });
      continue;
    }

    const rawAmount = humanAmountToRaw(humanAmount, decimals);

    if (!rawAmount) {
      console.warn({
        message: "⚠️ JUPITER SWAP QUOTE UNAVAILABLE",
        mint,
        reason: "invalid_quote_amount",
        humanAmount,
        decimals,
      });
      continue;
    }

    const url =
      `${JUPITER_SWAP_ORDER_URL}?` +
      new URLSearchParams({
        inputMint: mint,
        outputMint: wrappedSolMint,
        amount: rawAmount,
      }).toString();

    const response = await fetchJupiterWithRetry(
      url,
      jupiterApiKey,
      "JUPITER SWAP QUOTE"
    );

    if (!response) continue;

    try {
      const payload = await response.json();
      const outAmountLamports = Number(payload?.outAmount);

      if (!Number.isFinite(outAmountLamports) || outAmountLamports <= 0) {
        console.warn({
          message: "⚠️ JUPITER SWAP QUOTE UNAVAILABLE",
          mint,
          reason: "missing_or_invalid_out_amount",
          router: payload?.router || null,
          errorCode: payload?.errorCode ?? null,
          errorMessage: payload?.errorMessage || null,
        });
        continue;
      }

      const rawAmountNumber = Number(rawAmount);
      const quotedTokenAmount = rawAmountNumber / 10 ** decimals;
      const outSOL = outAmountLamports / 1_000_000_000;

      if (
        !Number.isFinite(quotedTokenAmount) ||
        quotedTokenAmount <= 0 ||
        !Number.isFinite(outSOL) ||
        outSOL <= 0
      ) {
        continue;
      }

      const priceSOLPerToken = outSOL / quotedTokenAmount;

      if (!Number.isFinite(priceSOLPerToken) || priceSOLPerToken <= 0) {
        continue;
      }

      prices.set(mint, {
        priceSOLPerToken,
        liquidityUSD: 0,
        pairAddress: null,
        dexId: payload?.router
          ? `JUPITER_SWAP_V2_${String(payload.router).toUpperCase()}`
          : "JUPITER_SWAP_V2",
        url: null,
        source: "JUPITER_SWAP_V2_QUOTE",
        quoteInputTokenAmount: quotedTokenAmount,
        quoteInputRawAmount: rawAmount,
        quoteOutputLamports: outAmountLamports,
        quoteOutputSOL: outSOL,
        tokenDecimals: decimals,
        router: payload?.router || null,
        requestId: payload?.requestId || null,
      });

      console.log({
        message: "🔄 JUPITER SWAP QUOTE PRICE",
        mint,
        router: payload?.router || null,
        quoteInputTokenAmount: quotedTokenAmount,
        quoteOutputSOL: outSOL,
        priceSOLPerToken,
        execution: "DISABLED",
        realMoney: false,
      });
    } catch (error) {
      console.warn({
        message: "⚠️ JUPITER SWAP QUOTE ERROR",
        mint,
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
    tokenAmountsByMint = null,
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

  const missingAfterPrice = uniqueMints.filter((mint) => !merged.has(mint));

  if (missingAfterPrice.length) {
    let swapQuotePrices = new Map();

    try {
      swapQuotePrices = await fetchJupiterSwapQuoteSolPrices(
        missingAfterPrice,
        wrappedSolMint,
        jupiterApiKey,
        tokenAmountsByMint
      );
    } catch (error) {
      console.warn({
        message: "⚠️ JUPITER SWAP QUOTE ERROR",
        reason: "unexpected_exception",
        error: String(error),
      });
    }

    for (const [mint, priceInfo] of swapQuotePrices.entries()) {
      if (!merged.has(mint)) merged.set(mint, priceInfo);
    }
  }

  const missingAfterSwap = uniqueMints.filter((mint) => !merged.has(mint));

  if (missingAfterSwap.length) {
    let dexPrices = new Map();

    try {
      dexPrices = await fetchDexScreenerSolPrices(
        missingAfterSwap,
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
    jupiterSwapQuoted: [...merged.values()].filter(
      (item) => item?.source === "JUPITER_SWAP_V2_QUOTE"
    ).length,
    dexScreenerPriced: [...merged.values()].filter(
      (item) => item?.source === "DEXSCREENER_SOL_QUOTE"
    ).length,
    missing: uniqueMints.filter((mint) => !merged.has(mint)).length,
  });

  return merged;
}
