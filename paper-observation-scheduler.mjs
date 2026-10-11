// Candidate research scheduler. Not imported by the production Worker.
// It selects observations only; it never changes exit rules or sends transactions.
export function selectResearchObservationCandidates(rows, nowMs, {
  limit = 4, recentSlots = 2, recentWindowMs = 15 * 60000,
} = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 8 ||
      !Number.isSafeInteger(recentSlots) || recentSlots < 0 || recentSlots >= limit ||
      !Number.isSafeInteger(recentWindowMs) || recentWindowMs <= 0)
    throw new Error('Invalid observation budget');
  const seen = new Set();
  const valid = rows.filter(p => {
    const admitted = Date.parse(p.admitted_at), checked = p.last_checked_at == null ? null : Date.parse(p.last_checked_at);
    if (p.status !== 'RESEARCH_OPEN' || typeof p.source_signature !== 'string' ||
        !p.source_signature || seen.has(p.source_signature) ||
        !Number.isFinite(admitted) || admitted > nowMs ||
        (checked !== null && (!Number.isFinite(checked) || checked > nowMs))) return false;
    seen.add(p.source_signature);return true;
  });
  const rank = p => Date.parse(p.last_checked_at ?? p.admitted_at);
  const compare = (a,b) => rank(a)-rank(b) || Date.parse(a.admitted_at)-Date.parse(b.admitted_at) ||
    a.source_signature.localeCompare(b.source_signature);
  const sorted = valid.slice().sort(compare);
  const recent = sorted.filter(p => nowMs-Date.parse(p.admitted_at) <= recentWindowMs).slice(0,recentSlots);
  const selected = new Set(recent.map(p=>p.source_signature));
  return recent.concat(sorted.filter(p=>!selected.has(p.source_signature)).slice(0,limit-recent.length));
}

export function observationCapacity({openPositions, limit=4, recentPositions=0, recentSlots=2, tickSeconds=60}) {
  if (![openPositions,recentPositions,limit,recentSlots,tickSeconds].every(Number.isSafeInteger) ||
      openPositions<0 || recentPositions<0 || recentPositions>openPositions || limit<1 ||
      recentSlots<0 || recentSlots>=limit || tickSeconds<1) throw new Error('Invalid capacity');
  const used = Math.min(recentSlots,recentPositions);
  return {baselineRotationSeconds: Math.ceil(openPositions/limit)*tickSeconds,
    recentRotationUpperSeconds: recentPositions ? Math.ceil(recentPositions/(used || limit))*tickSeconds : null,
    remainingRotationUpperSeconds: Math.ceil((openPositions-recentPositions)/(limit-used))*tickSeconds,
    caveat:'Planning bound only: assumes complete candidate set, stable arrivals and one successful observation per slot. TP slice quotes, provider delays and queue failures can lengthen it.'};
}
