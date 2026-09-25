const DEFAULT_WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";
const JUPITER_TOKENS_SEARCH_URL = "https://api.jup.ag/tokens/v2/search";
const JUPITER_SWAP_ORDER_URL = "https://api.jup.ag/swap/v2/order";
const DEXSCREENER_TOKEN_URL_PREFIX =
  "https://api.dexscreener.com/tokens/v1/solana/";
const COINGECKO_ONCHAIN_PRICE_URL_PREFIX =
  "https://api.coingecko.com/api/v3/onchain/simple/networks/solana/token_price/";

const JUPITER_MAX_TARGET_MINTS_PER_REQUEST = 49;
const JUPITER_TOKENS_MAX_MINTS_PER_REQUEST = 100;
const DEXSCREENER_MAX_TOKENS_PER_REQUEST = 30;
const COINGECKO_MAX_TARGET_MINTS_PER_REQUEST = 29;
const PRICE_FETCH_TIMEOUT_MS = 7000;
const JUPITER_MIN_REQUEST_SPACING_MS = 1100;
const RETRY_DELAYS_MS = [1200];

let lastJupiterRequestStartedAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = PRICE_FETCH_TIMEOUT_MS
) {
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
        reason:
          response.status === 429 ? "rate_limited" : "upstream_5xx",
        status: response.status,
        attempt: attempt + 1,
        delayMs,
      });
      await sleep(delayMs);
      continue;
    }

    let responseBody = null;

    try {
      responseBody = await response.text();
    } catch (bodyError) {
      responseBody = `UNREADABLE_BODY: ${String(bodyError)}`;
    }

    console.warn({
      message: `⚠️ ${logPrefix} ERROR`,
      reason: "http_error",
      status: response.status,
      responseBody,
    });
    return null;
  }

  return null;
}

async function fetchJupiterSolPrices(
  mints,
  wrappedSolMint,
  jupiterApiKey
) {
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
        if (!Number.isFinite(tokenUsdPrice) || tokenUsdPrice <= 0) {
          continue;
        }

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
      `${JUPITER_TOKENS_SEARCH_URL}?query=${encodeURIComponent(
        chunk.join(",")
      )}`,
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
    const humanAmount = getTokenAmountForMint(
      tokenAmountsByMint,
      mint
    );

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

      if (
        !Number.isFinite(outAmountLamports) ||
        outAmountLamports <= 0
      ) {
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
      const quotedTokenAmount =
        rawAmountNumber / 10 ** decimals;
      const outSOL = outAmountLamports / 1_000_000_000;

      if (
        !Number.isFinite(quotedTokenAmount) ||
        quotedTokenAmount <= 0 ||
        !Number.isFinite(outSOL) ||
        outSOL <= 0
      ) {
        continue;
      }

      const priceSOLPerToken =
        outSOL / quotedTokenAmount;

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
        dexId: payload?.router
          ? `JUPITER_SWAP_V2_${String(
              payload.router
            ).toUpperCase()}`
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

async function fetchCoinGeckoMarkSolPrices(
  mints,
  wrappedSolMint,
  coingeckoApiKey
) {
  const uniqueMints = [...new Set((mints || []).filter(Boolean))];
  const prices = new Map();

  if (!coingeckoApiKey) {
    console.warn({
      message: "⚠️ COINGECKO MARK PRICE ERROR",
      reason: "missing_api_key",
      behavior: "positions_without_mark_price_will_be_skipped",
    });
    return prices;
  }

  for (
    let offset = 0;
    offset < uniqueMints.length;
    offset += COINGECKO_MAX_TARGET_MINTS_PER_REQUEST
  ) {
    const chunk = uniqueMints.slice(
      offset,
      offset + COINGECKO_MAX_TARGET_MINTS_PER_REQUEST
    );

    if (!chunk.length) continue;

    const addresses = [
      ...new Set([...chunk, wrappedSolMint]),
    ];

    const url =
      COINGECKO_ONCHAIN_PRICE_URL_PREFIX +
      addresses
        .map((address) => encodeURIComponent(address))
        .join(",");

    let response = null;

    try {
      response = await fetchWithTimeout(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-cg-demo-api-key": coingeckoApiKey,
        },
      });
    } catch (error) {
      console.warn({
        message: "⚠️ COINGECKO MARK PRICE ERROR",
        reason: "network_or_timeout",
        error: String(error),
      });
      continue;
    }

    if (response.status === 429) {
      console.warn({
        message: "⚠️ COINGECKO MARK PRICE RATE LIMITED",
        status: response.status,
        behavior:
          "positions_without_mark_price_will_be_skipped",
      });
      break;
    }

    if (!response.ok) {
      let responseBody = null;

      try {
        responseBody = await response.text();
      } catch (bodyError) {
        responseBody = `UNREADABLE_BODY: ${String(bodyError)}`;
      }

      console.warn({
        message: "⚠️ COINGECKO MARK PRICE ERROR",
        reason: "http_error",
        status: response.status,
        responseBody,
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

      if (
        !Number.isFinite(solUsdPrice) ||
        solUsdPrice <= 0
      ) {
        console.warn({
          message: "⚠️ COINGECKO MARK PRICE ERROR",
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
          dexId: "COINGECKO_ONCHAIN",
          url: null,
          source: "COINGECKO_MARK_USD_RATIO",
          tokenUsdPrice,
          solUsdPrice,
        });
      }
    } catch (error) {
      console.warn({
        message: "⚠️ COINGECKO MARK PRICE ERROR",
        reason: "invalid_json",
        error: String(error),
      });
    }
  }

  return prices;
}

export async function fetchJupiterExecutableSellQuote({
  mint,
  tokenAmount,
  wrappedSolMint = DEFAULT_WRAPPED_SOL_MINT,
  jupiterApiKey = null,
} = {}) {
  const amount = Number(tokenAmount);

  if (!mint) {
    return {
      executable: false,
      reason: "missing_mint",
    };
  }

  if (!jupiterApiKey) {
    return {
      executable: false,
      reason: "missing_api_key",
      mint,
    };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      executable: false,
      reason: "invalid_token_amount",
      mint,
      tokenAmount: amount,
    };
  }

  const decimalsByMint =
    await fetchJupiterTokenDecimals(
      [mint],
      jupiterApiKey
    );

  const decimals = decimalsByMint.get(mint);

  if (!Number.isInteger(decimals)) {
    return {
      executable: false,
      reason: "missing_token_decimals",
      mint,
      tokenAmount: amount,
    };
  }

  const rawAmount = humanAmountToRaw(
    amount,
    decimals
  );

  if (!rawAmount) {
    return {
      executable: false,
      reason: "invalid_quote_amount",
      mint,
      tokenAmount: amount,
      decimals,
    };
  }

  const url =
    `${JUPITER_SWAP_ORDER_URL}?` +
    new URLSearchParams({
      inputMint: mint,
      outputMint: wrappedSolMint,
      amount: rawAmount,
    }).toString();

  let response = null;

  for (
    let attempt = 0;
    attempt <= RETRY_DELAYS_MS.length;
    attempt++
  ) {
    try {
      response = await fetchJupiterWithPacing(
        url,
        jupiterApiKey
      );
    } catch (error) {
      if (attempt < RETRY_DELAYS_MS.length) {
        const delayMs =
          RETRY_DELAYS_MS[attempt];
        await sleep(delayMs);
        continue;
      }

      return {
        executable: false,
        reason: "network_or_timeout",
        mint,
        tokenAmount: amount,
        rawAmount,
        decimals,
        error: String(error),
      };
    }

    if (response.ok) break;

    let responseBody = null;

    try {
      responseBody = await response.text();
    } catch (bodyError) {
      responseBody =
        `UNREADABLE_BODY: ${String(bodyError)}`;
    }

    if (
      (response.status === 429 ||
        response.status >= 500) &&
      attempt < RETRY_DELAYS_MS.length
    ) {
      const delayMs =
        RETRY_DELAYS_MS[attempt];
      await sleep(delayMs);
      continue;
    }

    const noRoute =
      response.status === 400 &&
      /failed to get quotes/i.test(
        String(responseBody || "")
      );

    return {
      executable: false,
      reason: noRoute
        ? "no_route"
        : "http_error",
      mint,
      tokenAmount: amount,
      rawAmount,
      decimals,
      status: response.status,
      responseBody,
    };
  }

  if (!response?.ok) {
    return {
      executable: false,
      reason: "quote_provider_unavailable",
      mint,
      tokenAmount: amount,
      rawAmount,
      decimals,
      status: response?.status ?? null,
    };
  }

  try {
    const payload = await response.json();
    const outAmountLamports =
      Number(payload?.outAmount);

    if (
      !Number.isFinite(outAmountLamports) ||
      outAmountLamports <= 0
    ) {
      return {
        executable: false,
        reason: "missing_or_invalid_out_amount",
        mint,
        tokenAmount: amount,
        rawAmount,
        decimals,
        status: response.status,
        router: payload?.router || null,
        requestId: payload?.requestId || null,
        errorCode: payload?.errorCode ?? null,
        errorMessage:
          payload?.errorMessage ||
          payload?.error ||
          null,
      };
    }

    const rawAmountNumber = Number(rawAmount);
    const quotedTokenAmount =
      rawAmountNumber / 10 ** decimals;
    const outSOL =
      outAmountLamports / 1_000_000_000;

    const effectivePriceSOLPerToken =
      outSOL / quotedTokenAmount;

    if (
      !Number.isFinite(quotedTokenAmount) ||
      quotedTokenAmount <= 0 ||
      !Number.isFinite(outSOL) ||
      outSOL <= 0 ||
      !Number.isFinite(
        effectivePriceSOLPerToken
      ) ||
      effectivePriceSOLPerToken <= 0
    ) {
      return {
        executable: false,
        reason: "invalid_quote_math",
        mint,
        tokenAmount: amount,
        rawAmount,
        decimals,
        status: response.status,
      };
    }

    return {
      executable: true,
      reason: "quote_available",
      mint,
      tokenAmount: amount,
      quotedTokenAmount,
      rawAmount,
      decimals,
      status: response.status,
      outAmountLamports,
      outSOL,
      effectivePriceSOLPerToken,
      router: payload?.router || null,
      requestId: payload?.requestId || null,
    };
  } catch (error) {
    return {
      executable: false,
      reason: "invalid_json",
      mint,
      tokenAmount: amount,
      rawAmount,
      decimals,
      status: response.status,
      error: String(error),
    };
  }
}

function selectBestSolQuotedPair(
  pairs,
  mint,
  wrappedSolMint
) {
  let best = null;

  for (const pair of pairs) {
    if (pair?.chainId !== "solana") continue;
    if (pair?.baseToken?.address !== mint) {
      continue;
    }
    if (
      pair?.quoteToken?.address !==
      wrappedSolMint
    ) {
      continue;
    }

    const priceSOLPerToken =
      Number(pair?.priceNative);
    const liquidityUSD =
      Number(pair?.liquidity?.usd || 0);

    if (
      !Number.isFinite(priceSOLPerToken) ||
      priceSOLPerToken <= 0
    ) {
      continue;
    }

    if (
      !best ||
      liquidityUSD > best.liquidityUSD
    ) {
      best = {
        priceSOLPerToken,
        liquidityUSD:
          Number.isFinite(liquidityUSD)
            ? liquidityUSD
            : 0,
        pairAddress:
          pair?.pairAddress || null,
        dexId: pair?.dexId || null,
        url: pair?.url || null,
        source: "DEXSCREENER_SOL_QUOTE",
      };
    }
  }

  return best;
}

async function fetchDexScreenerSolPrices(
  mints,
  wrappedSolMint
) {
  const uniqueMints = [
    ...new Set(
      (mints || []).filter(Boolean)
    ),
  ];

  const prices = new Map();

  for (
    let offset = 0;
    offset < uniqueMints.length;
    offset += DEXSCREENER_MAX_TOKENS_PER_REQUEST
  ) {
    const chunk = uniqueMints.slice(
      offset,
      offset +
        DEXSCREENER_MAX_TOKENS_PER_REQUEST
    );

    if (!chunk.length) continue;

    let response = null;
    let failed = false;

    for (
      let attempt = 0;
      attempt <= RETRY_DELAYS_MS.length;
      attempt++
    ) {
      try {
        response = await fetchWithTimeout(
          `${DEXSCREENER_TOKEN_URL_PREFIX}${chunk.join(
            ","
          )}`,
          {
            method: "GET",
            headers: {
              accept: "application/json",
            },
          }
        );
      } catch (error) {
        if (
          attempt <
          RETRY_DELAYS_MS.length
        ) {
          const delayMs =
            RETRY_DELAYS_MS[attempt];

          console.warn({
            message:
              "⚠️ DEXSCREENER RETRY",
            reason:
              "network_or_timeout",
            attempt: attempt + 1,
            delayMs,
            error: String(error),
          });

          await sleep(delayMs);
          continue;
        }

        console.warn({
          message:
            "⚠️ DEXSCREENER PRICE PROVIDER ERROR",
          reason:
            "network_or_timeout",
          error: String(error),
        });

        failed = true;
        break;
      }

      if (response.ok) break;

      if (response.status === 429) {
        console.warn({
          message:
            "⚠️ DEXSCREENER RATE LIMITED",
          status: response.status,
          behavior:
            "position_without_price_will_be_skipped",
        });

        failed = true;
        break;
      }

      if (
        response.status >= 500 &&
        attempt <
          RETRY_DELAYS_MS.length
      ) {
        const delayMs =
          RETRY_DELAYS_MS[attempt];

        console.warn({
          message:
            "⚠️ DEXSCREENER RETRY",
          reason: "upstream_5xx",
          status: response.status,
          attempt: attempt + 1,
          delayMs,
        });

        await sleep(delayMs);
        continue;
      }

      console.warn({
        message:
          "⚠️ DEXSCREENER PRICE PROVIDER ERROR",
        reason: "http_error",
        status: response.status,
      });

      failed = true;
      break;
    }

    if (failed || !response?.ok) {
      continue;
    }

    try {
      const payload =
        await response.json();

      const pairs =
        Array.isArray(payload)
          ? payload
          : [];

      for (const mint of chunk) {
        const best =
          selectBestSolQuotedPair(
            pairs,
            mint,
            wrappedSolMint
          );

        if (best) {
          prices.set(mint, best);
        }
      }
    } catch (error) {
      console.warn({
        message:
          "⚠️ DEXSCREENER PRICE PROVIDER ERROR",
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
    wrappedSolMint =
      DEFAULT_WRAPPED_SOL_MINT,
    coingeckoApiKey = null,
  } = {}
) {
  const uniqueMints = [
    ...new Set(
      (mints || []).filter(Boolean)
    ),
  ];

  let markPrices = new Map();

  try {
    markPrices =
      await fetchCoinGeckoMarkSolPrices(
        uniqueMints,
        wrappedSolMint,
        coingeckoApiKey
      );
  } catch (error) {
    console.warn({
      message:
        "⚠️ COINGECKO MARK PRICE ERROR",
      reason: "unexpected_exception",
      error: String(error),
    });
  }

  console.log({
    message:
      "💹 PAPER MARK PRICE PROVIDER",
    requested: uniqueMints.length,
    coinGeckoPriced:
      markPrices.size,
    missing: uniqueMints.filter(
      (mint) =>
        !markPrices.has(mint)
    ).length,
    source:
      "COINGECKO_DEMO_ONCHAIN",
    execution: "DISABLED",
    realMoney: false,
  });

  return markPrices;
            }
