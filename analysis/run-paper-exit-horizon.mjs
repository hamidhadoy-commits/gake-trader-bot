import fs from 'node:fs';import {analyze} from './paper-exit-horizon.mjs';
const [input,output,from,limitText]=process.argv.slice(2);if(!input||!output)throw Error('Usage: node analysis/run-paper-exit-horizon.mjs CAPTURE.json OUTPUT.json [COHORT_FROM_ISO] [FIRST_N]');
const dataset=JSON.parse(fs.readFileSync(input,'utf8'));
if(from){if(!Number.isFinite(Date.parse(from)))throw Error('INVALID_COHORT_FROM');dataset.positions=dataset.positions.filter(p=>Date.parse(p.admitted_at)>=Date.parse(from));}
const limit=limitText===undefined?null:Number(limitText);
if(limit!==null){if(!from||!Number.isSafeInteger(limit)||limit<1)throw Error('INVALID_COHORT_LIMIT');dataset.positions.sort((a,b)=>Date.parse(a.admitted_at)-Date.parse(b.admitted_at)||a.source_signature.localeCompare(b.source_signature));dataset.positions=dataset.positions.slice(0,limit);}
const result=analyze(dataset);result.cohortSelection={from:from??null,firstN:limit,actualCount:dataset.positions.length,requiredCountReached:limit===null?null:dataset.positions.length===limit};
fs.writeFileSync(output,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({asOf:result.asOf,cohort:result.cohortSelection,scenarios:result.scenarios.map(({rows,...s})=>s)}));
