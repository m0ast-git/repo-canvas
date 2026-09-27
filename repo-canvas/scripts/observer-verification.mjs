import fs from "node:fs";
import path from "node:path";
import { observerEvents, validateArchitecture, applyObserverDecision } from "./semantic-model.mjs";
import { getSnapshot, appendEvent, createEvent } from "./canvas-store.mjs";
import { evidencePackage, evidenceReviewPrompt, EVIDENCE_REVIEW_SCHEMA, assertEvidenceUnchanged } from "./evidence-review.mjs";
import { codeState, readCodeSource } from "./project-sources.mjs";
import { semanticSignature } from "./semantic-signature.mjs";
import { archiveEvidence } from "./source-archive.mjs";

// A model may append an explanation after a reference. Keep only a verified address,
// never reinterpret an arbitrary sentence as evidence or broaden a broken line range.
export function normalizeObserverEvidence(root, decision) {
  const clean=reference=>{
    if(typeof reference!=="string"||reference.startsWith("dialog:")||!readCodeSource(root,reference).error)return reference;
    const prefix=reference.match(/^(.+?\.[a-z\d]+(?:(?::\d+(?:[-:]\d+)?)|(?:(?:#|::)[\w.$]+))?)\s+/i)?.[1];
    return prefix&&!readCodeSource(root,prefix).error?prefix:reference;
  };
  return {...decision,entityChanges:(decision.entityChanges||[]).map(item=>({...item,evidence:(item.evidence||[]).map(clean)})),relationChanges:(decision.relationChanges||[]).map(item=>({...item,evidence:(item.evidence||[]).map(clean)}))};
}

export function proposalStamp(root,decision) {
  const refs=[...(decision.entityChanges||[]).flatMap(item=>[item.path,...(item.evidence||[])]),...(decision.relationChanges||[]).flatMap(item=>item.evidence||[])].filter(Boolean);
  return refs.filter(ref=>!ref.startsWith("dialog:")).map(ref=>{
    const file=path.resolve(root,ref.split(/#|::|:\d/)[0]);
    try {const stat=fs.statSync(file);return `${ref}:${stat.size}:${stat.mtimeMs}`;}catch{return `${ref}:missing`;}
  }).join("|")+semanticSignature(getSnapshot());
}
export async function verifyObserverProposal(decision,context,{root,runner,signal}={}) {
  decision=normalizeObserverEvidence(root,decision);
  const snapshot=getSnapshot();const events=observerEvents(decision,{...context,verified:true});
  const entities=new Map(snapshot.entities.map(item=>[item.id,item]));const relations=new Map(snapshot.relations.map(item=>[item.id,item]));
  for(const event of events) {
    const item=event.payload;
    if(event.type==="entity.upsert") entities.set(item.id,{...entities.get(item.id),...item});
    if(event.type==="relation.upsert") relations.set(item.id,{...relations.get(item.id),...item});
    if(event.type==="entity.remove") {entities.delete(item.id);for(const [id,relation] of relations) if([relation.from,relation.to].includes(item.id))relations.delete(id);}
    if(event.type==="relation.remove") relations.delete(item.id);
  }
  const value={...snapshot.map,areas:snapshot.areas,entities:[...entities.values()],relations:[...relations.values()],removedEntityIds:(decision.entityChanges||[]).filter(item=>item.operation==="remove").map(item=>item.entityId),removedRelationIds:(decision.relationChanges||[]).filter(item=>item.operation==="remove").map(item=>item.relationId)};
  try {
    validateArchitecture(value,snapshot);
    const ids=new Set((decision.entityChanges||[]).map(item=>item.entityId));
    const relationIds=new Set((decision.relationChanges||[]).map(item=>item.relationId));
    const relevant={...value,areas:[],entities:[...value.entities,...snapshot.entities.filter(item=>value.removedEntityIds.includes(item.id))].filter(item=>ids.has(item.id)),relations:value.relations.filter(item=>relationIds.has(item.id))};
    const sources=evidencePackage(root,relevant);
    const unreadable=sources.sources.filter(source=>source.error);
    if(unreadable.length){const error=new Error("Не удалось прочитать ссылки, указанные моделью");error.code="unreadable-evidence";error.references=unreadable.map(source=>source.reference);throw error;}
    const reviewed=await runner({role:"verifier",cwd:root,signal,prompt:evidenceReviewPrompt({changes:decision,before:{entities:snapshot.entities.filter(item=>ids.has(item.id)),relations:snapshot.relations.filter(item=>relationIds.has(item.id))},after:relevant},sources,snapshot.map.knowledge),outputSchema:EVIDENCE_REVIEW_SCHEMA});
    if(!reviewed.value.passed || reviewed.value.issues.some(issue=>issue.severity!=="warning")){const error=new Error(reviewed.value.summary || "Изменение не подтверждено исходниками");error.code="verification-failed";throw error;}
    assertEvidenceUnchanged(root,sources);
    archiveEvidence(root,sources);
    applyObserverDecision(decision,{...context,verified:true,expectedSignature:semanticSignature(snapshot),verification:{state:"source-checked",at:new Date().toISOString(),code:codeState(root),sourceHashes:sources.sources.filter(source=>source.hash).map(({reference,hash})=>({reference,hash})),testStatus:"not-executed"}});
    return {passed:true};
  } catch(error) {
    if(signal?.aborted) throw error;
    const work=getSnapshot().work.find(item=>item.id===context.workId);
    if(work) {const {actor,updatedAt,...payload}=work;appendEvent(createEvent("work.upsert",{actor:"observer",payload:{...payload,verification:{state:"needs-review",reason:String(error.message).slice(0,1800),trigger:"source-change-or-retry"},proposedChanges:decision}}));}
    return {passed:false,reason:error.message,issue:{code:error.code||"verification-failed",references:error.references||[]},stamp:proposalStamp(root,decision)};
  }
}
