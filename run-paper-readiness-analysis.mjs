import fs from 'node:fs';
import {buildPaperReadinessEvidence} from './paper-readiness-analysis.mjs';
// Offline evidence only: no network, signing, wallet or database mutation.
const [metricsPath,cadencePath,entryPath,outputPath]=process.argv.slice(2);
if(!metricsPath||!cadencePath||!entryPath)throw Error('Usage: node run-paper-readiness-analysis.mjs METRICS_JSON CADENCE_SUMMARY_JSON ENTRY_SUMMARY_JSON [OUTPUT_JSON]');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const report=buildPaperReadinessEvidence(read(metricsPath),read(cadencePath),read(entryPath));
const text=JSON.stringify(report,null,2);
if(outputPath)fs.writeFileSync(outputPath,text,{flag:'wx'});
console.log(text);
