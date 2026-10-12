// Keep one coherent provider response, including SOL, within the existing 30-address budget.
export const HOST_FEED_SELECTION_SQL = `WITH candidates AS (
 SELECT mint,0 AS priority,'' AS rank_time,opened_at AS admitted_at,source_signature
 FROM paper_copy_positions WHERE status='PAPER_OPEN' AND remaining_token_amount>0
 UNION ALL
 SELECT mint,1 AS priority,COALESCE(last_checked_at,admitted_at) AS rank_time,admitted_at,source_signature
 FROM paper_research_positions WHERE status='RESEARCH_OPEN'
)
SELECT mint,MIN(priority) AS priority,MIN(rank_time) AS rank_time,
 MIN(admitted_at) AS admitted_at,MIN(source_signature) AS source_signature
FROM candidates GROUP BY mint
ORDER BY priority,rank_time,admitted_at,source_signature LIMIT 30`;
export function selectHostFeedMints(rows) {
 if (!Array.isArray(rows)||rows.length>30) throw Error('HOST_FEED_SELECTION_INVALID');
 if(rows.some(x=>typeof x.mint!=='string'||!x.mint||![0,1].includes(x.priority)))throw Error('HOST_FEED_SELECTION_INVALID');
 if(new Set(rows.map(x=>x.mint)).size!==rows.length)throw Error('HOST_FEED_SELECTION_INVALID');
 if(rows.filter(x=>x.priority===0).length>29)throw Error('HOST_FEED_MAIN_BATCH_LIMIT');
 const mints=rows.slice(0,29).map(x=>x.mint);
 return {mints,capacityLimited:rows.length>29,observedMintsLowerBound:rows.length};
}
