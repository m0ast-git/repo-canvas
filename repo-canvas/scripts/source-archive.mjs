import crypto from "node:crypto";
import path from "node:path";
import { resolveDataDirectory } from "./project-root.mjs";
import { readSourceJson, writeSourceJson, readCodeSource } from "./project-sources.mjs";
const key=(reference,hash)=>crypto.createHash("sha256").update(`${reference}\0${hash}`).digest("hex");
export function archiveEvidence(root,sources) {
  for(const source of sources?.sources||[])if(source.hash&&source.reference&&(source.text||source.coveredBy)&&!source.reference.startsWith("dialog:"))writeSourceJson(path.join(resolveDataDirectory(root),"sources","evidence",key(source.reference,source.hash)+".json"),source);
}
export function readHistoricalEvidence(root,snapshot,reference) {
  const hashes=[...(snapshot.map?.verification?.sourceHashes||[]),...snapshot.entities.flatMap(item=>item.verification?.sourceHashes||[]),...snapshot.relations.flatMap(item=>item.verification?.sourceHashes||[])];
  const record=hashes.find(item=>item.reference===reference);
  if(!record)return {reference,error:"Фрагмент источника не был записан вместе с этим состоянием. Текущий файл может отличаться."};
  const source=readSourceJson(path.join(resolveDataDirectory(root),"sources","evidence",key(reference,record.hash)+".json"),null);
  if(source){if(source.coveredBy){const full=readSourceJson(path.join(resolveDataDirectory(root),"sources","evidence",key(source.coveredBy,source.hash)+".json"),null);if(full?.text)return {...full,...source,text:full.text,historical:true};}if(source.text)return {...source,historical:true};}
  const current=readCodeSource(root,reference);
  return current.hash===record.hash?{...current,historical:true,unchangedSinceCheckpoint:true}:{reference,error:"Источник изменён или удалён; сохранённого фрагмента для этого состояния нет."};
}
