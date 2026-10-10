import {probeNetlifyReferenceFeed,SOL} from './netlify-reference-feed.js';
import {decodeHostReferenceFeed} from './price-provider.js';
const UPSERT = 'INSERT INTO paper_reference_price_feed(id,observed_at,payload_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,payload_json=excluded.payload_json WHERE excluded.observed_at>paper_reference_price_feed.observed_at';
// Prepared for a later reviewed cutover. Nothing imports this in the live Worker.
// Read-only by default; no new credentials, bindings, schema or scheduled job.
export async function refreshNetlifyReferenceFeed(db,
    {publish = false, probe = probeNetlifyReferenceFeed, clock = Date.now, fetcher = fetch} = {}) {
  try {
    const result = await probe(db,{clock,fetcher});
    if (result.status !== 'ACCEPTED') return {status:result.status,feedWritten:false};
    const row = result.row, payload = JSON.parse(row.payload_json);
    const mints = Object.keys(payload.tokenPrices).filter(x=>x!==SOL);
    const prices = decodeHostReferenceFeed(row,mints,SOL,clock());
    if (!prices.size) return {status:'NO_FRESH_TOKEN_PRICES',feedWritten:false};
    const summary = {requested:result.requested,priced:prices.size,observedAt:row.observed_at,feedWritten:false};
    if (publish !== true) return {...summary,status:'READY_READ_ONLY'};
    const write = await db.prepare(UPSERT).bind(row.observed_at,row.payload_json).run();
    if (!write.success) return {...summary,status:'PUBLISH_FAILED'};
    return {...summary,status:write.meta?.changes===1?'PUBLISHED':'NEWER_FEED_PRESERVED',
      feedWritten:write.meta?.changes===1};
  } catch {return {status:'PUBLISH_FAILED',feedWritten:false};}
}
