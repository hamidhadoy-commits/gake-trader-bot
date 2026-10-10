import {decodeHostReferenceFeed} from './price-provider.js';
export const NETLIFY_REFERENCE_URL = 'https://gake-netlify-price-probe.netlify.app/.netlify/functions/probe';
export const SOL = 'So11111111111111111111111111111111111111112';
const ACTIVE_MINTS_SQL = "SELECT DISTINCT mint FROM paper_copy_positions WHERE status='PAPER_OPEN' AND remaining_token_amount>0 UNION SELECT DISTINCT mint FROM paper_research_positions WHERE status='RESEARCH_OPEN'";
const validMint = x => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
// Read-only transport adapter. No database write, secret forwarding or retry.
export async function probeNetlifyReferenceFeed(db, {fetcher = fetch, clock = Date.now, timeoutMs = 12000} = {}) {
  try {
    const selected = await db.prepare(ACTIVE_MINTS_SQL).all();
    if (!selected?.success || !Array.isArray(selected.results)) return {status:'MINT_READ_REJECTED'};
    const mints = [...new Set(selected.results.map(x => x.mint))];
    if (!mints.length) return {status:'NO_ACTIVE_MINTS'};
    if (mints.length > 29 || !mints.every(validMint)) return {status:'MINT_BATCH_REJECTED'};
    const controller = new AbortController(), started = clock();
    let timer;
    const deadline = new Promise((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(new Error('DEADLINE'));}, timeoutMs);});
    let body;
    try {
      body = await Promise.race([(async () => {
        const response = await fetcher(NETLIFY_REFERENCE_URL, {method:'POST',
          headers:{'content-type':'application/json'},body:JSON.stringify({mints}),
          signal:controller.signal,redirect:'error'});
        if (!response.ok) throw new Error('HTTP_REJECTED');
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let size = 0, text = '';
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 65536) {await reader.cancel(); throw new Error('BODY_LIMIT');}
          text += decoder.decode(chunk.value,{stream:true});
        }
        return JSON.parse(text + decoder.decode());
      })(), deadline]);
    } finally {clearTimeout(timer);}
    const completed = clock();
    if (body?.status !== 'TRANSPORT_ACCEPTED' || body.attempts !== 1 ||
        body.productionConnected !== false || body.requested !== mints.length ||
        completed < started || completed - started > timeoutMs) return {status:'TRANSPORT_REJECTED'};
    const tokenPrices = {};
    for (const mint of [...mints,SOL]) {
      const price = body.tokenPrices?.[mint];
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) tokenPrices[mint] = price;
    }
    const row = {observed_at:body.observedAt,payload_json:JSON.stringify({
      schemaVersion:1,provider:'GECKOTERMINAL_PUBLIC',wrappedSolMint:SOL,
      tokenPrices,responseMetadata:body.responseMetadata})};
    // Use the unchanged production gate, including cache age + transit time.
    if (!decodeHostReferenceFeed(row,[SOL],SOL,completed).has(SOL)) return {status:'FRESHNESS_REJECTED'};
    const prices = decodeHostReferenceFeed(row,mints,SOL,completed);
    return {status:'ACCEPTED',requested:mints.length,priced:prices.size,
      missing:mints.filter(x=>!prices.has(x)),elapsedMs:completed-started,row};
  } catch {return {status:'REQUEST_FAILED'};}
}

// Exactly these three future cron slots can run the read-only production canary.
// Empty by default; populate only immediately before a bounded deployment.
export const NETLIFY_CANARY_SLOTS = [1791658680000,1791658740000,1791658800000];
export async function runNetlifyReferenceCanary(env, scheduledTime,
    {slots = NETLIFY_CANARY_SLOTS, clock = Date.now, probe = probeNetlifyReferenceFeed} = {}) {
  const now = clock();
  if (slots.length > 3 || !slots.includes(scheduledTime) || now < scheduledTime ||
      now - scheduledTime > 70000) return {status:'DISABLED'};
  try {
    const result = await probe(env.DB);
    const summary = {message:'NETLIFY REFERENCE CANARY',scheduledTime,status:result.status,
      requested:result.requested,priced:result.priced,elapsedMs:result.elapsedMs,
      observedAt:result.row?.observed_at,cacheAgeSeconds:result.row ? JSON.parse(result.row.payload_json).responseMetadata?.responseAgeSeconds : undefined,
      feedWritten:false,execution:'DISABLED',realMoney:false};
    console.log(summary);
    return summary;
  } catch {
    const summary = {message:'NETLIFY REFERENCE CANARY',scheduledTime,status:'CANARY_FAILED',feedWritten:false};
    console.warn(summary);return summary;
  }
}
