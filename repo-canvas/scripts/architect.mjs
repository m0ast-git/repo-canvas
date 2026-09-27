import {promptTemplate} from "./prompt-template.mjs";
import crypto from "node:crypto";
import { archiveEvidence } from "./source-archive.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runStructured, createProviderSession, selectModelProfile, taskComplexity } from "./model-providers.mjs";
import { readRuntimeConfig } from "./runtime-config.mjs";
import { readCodeSource, sourceInventory, sourcePackage, readDialogSource, codeState, readSourceJson, writeSourceJson, repositoryFiles } from "./project-sources.mjs";
import { collectProjectKnowledge, readProjectKnowledge, publicKnowledge } from "./project-knowledge.mjs";
import { EVIDENCE_REVIEW_SCHEMA, evidencePackage, evidenceReviewPrompt, assertEvidenceUnchanged, focusEvidenceMap } from "./evidence-review.mjs";
import { getSnapshot } from "./canvas-store.mjs";
import { semanticSignature } from "./semantic-signature.mjs";
import { projectRoot, resolveDataDirectory } from "./project-root.mjs";
import { MODEL_PROFILES, createCodexStructuredSession, runCodexStructured } from "./model-runtime.mjs";
import { ARCHITECT_OUTPUT_SCHEMA, ARCHITECT_REVIEW_SCHEMA, applyArchitecture, validateArchitecture, normalizeArchitecture } from "./semantic-model.mjs";
import {buildModuleCards,enrichModuleCards,moduleContext,selectInitialReferences} from "./module-cards.mjs";

function compactCurrentMap(snapshot) {
  return {
    map: snapshot.map,
    areas: snapshot.areas.map(({ id, title, note, color, evidence, ownerTitle, ownerNote }) => ({ id, title, note, color, evidence, ownerTitle, ownerNote })),
    entities: snapshot.entities.map(({ id, areaId, parentId, label, kind, status, purpose, path, evidence, ownerLabel, ownerPurpose }) => ({ id, areaId, parentId, label, kind, status, purpose, path, evidence, ownerLabel, ownerPurpose })),
    relations: snapshot.relations.map(({ id, from, to, label, kind, contract, mechanism, evidence, status, ownerLabel }) => ({ id, from, to, label, kind, contract, mechanism, evidence, status, ownerLabel })),
  };
}

export function architectPrompt({ snapshot, refresh, viewpoint = "", language = null }) {
  return promptTemplate("architect",{LANGUAGE:language||"infer from the owner's messages and existing map",REFRESH:refresh?"yes":"no",VIEWPOINT:viewpoint||"No additional preference",CURRENT_MAP:refresh?JSON.stringify(compactCurrentMap(snapshot)):"No prior map."});
}

function sameIds(before, after, field) {
  const left = [...new Set((before || []).map((item) => typeof item === "string" ? item : item[field]))].sort();
  const right = [...new Set((after || []).map((item) => typeof item === "string" ? item : item[field]))].sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function normalizeLanguageTag(value) {
  const normalized = String(value || "").trim().replaceAll("_", "-").toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized) ? normalized : null;
}

export function preferredMapLanguage(viewpoint = "", snapshot = { map: {}, areas: [], entities: [], relations: [] }, repositoryText = "", requestedLanguage = "") {
  const explicit = String(viewpoint || "").trim();
  if ((explicit.match(/[А-Яа-яЁё]/g) || []).length >= 2) return "ru";
  if (!/[А-Яа-яЁё]/.test(explicit) && (explicit.match(/[A-Za-z]/g) || []).length >= 4) return "en";
  const requested = normalizeLanguageTag(requestedLanguage);
  if (requested) return requested;
  const stored = normalizeLanguageTag(snapshot.map?.language);
  if (stored) return stored;
  const current = [
    snapshot.map?.projectTitle, snapshot.map?.projectSummary,
    ...snapshot.areas.flatMap((item) => [item.ownerTitle || item.title, item.ownerNote || item.note]),
    ...snapshot.entities.flatMap((item) => [item.ownerLabel || item.label, item.ownerPurpose || item.purpose]),
    ...snapshot.relations.map((item) => item.ownerLabel || item.label),
  ].filter(Boolean).join(" ");
  const cyrillic = (current.match(/[А-Яа-яЁё]/g) || []).length;
  const latin = (current.match(/[A-Za-z]/g) || []).length;
  if (cyrillic >= 20 && cyrillic > latin * .35) return "ru";
  const repositoryCyrillic = (repositoryText.match(/[А-Яа-яЁё]/g) || []).length;
  const repositoryLatin = (repositoryText.match(/[A-Za-z]/g) || []).length;
  if (repositoryCyrillic >= 20 && repositoryCyrillic > repositoryLatin * .2) return "ru";
  if (repositoryLatin >= 20 && repositoryCyrillic === 0) return "en";
  return null;
}

function repositoryLanguageSample(root) {
  const candidates = ["README.md", "README", path.join("docs", "README.md"), "package.json", "pyproject.toml"];
  const chunks = [];
  for (const candidate of candidates) {
    try { chunks.push(fs.readFileSync(path.join(root, candidate), "utf8").slice(0, 80_000)); }
    catch { /* optional language evidence */ }
  }
  return chunks.join("\n");
}

function visibleFields(value) {
  const output = [
    ["map.projectTitle", value.projectTitle], ["map.projectSummary", value.projectSummary],
    ...value.areas.flatMap((item) => [[`area.${item.id}.title`, item.title], [`area.${item.id}.note`, item.note]]),
    ...value.entities.flatMap((item) => [[`entity.${item.id}.label`, item.label], [`entity.${item.id}.purpose`, item.purpose], [`entity.${item.id}.note`, item.note]]),
    ...value.relations.map((item) => [`relation.${item.id}.label`, item.label]),
    ...(value.keyFlows || []).flatMap((item) => [[`flow.${item.id}.title`, item.title], [`flow.${item.id}.trigger`, item.trigger], [`flow.${item.id}.outcome`, item.outcome]]),
    ...(value.unresolvedQuestions || []).map((item, index) => [`unresolvedQuestions.${index}`, item]),
  ];
  return output.filter(([, text]) => typeof text === "string" && text.trim());
}

const UNTRANSLATED_RUSSIAN_GENERIC = /\b(runtime|workflow|feedback|corrections?|proposed|output|request|response|pipeline|handler|store|adapter|engine|router|status|signals?|overrides?)\b/gi;

export function architectureLanguageIssues(value, language, readerProfile = {}) {
  if (!language) return [];
  const issues = [];
  for (const [field, text] of visibleFields(value)) {
    if (/^ru(?:-|$)/.test(language)) {
      const singleTechnicalName = /^[A-Za-z][A-Za-z0-9+.#/-]{1,30}$/.test(text.trim());
      if (field!=="map.projectTitle" && !/[А-Яа-яЁё]/.test(text) && !singleTechnicalName) issues.push(`${field} must use Russian owner-facing language`);
      const prose=text.replace(/(?:^|\s)(?:\/|\.repo-canvas\/)[^\s,;]+|`[^`]*`|[\w./-]+\.(?:[cm]?jsx?|tsx?|py|md|json|toml)(?::\d+(?:-\d+)?)?|["'][A-Za-z_][\w.]*["']|\.[A-Za-z_][\w.]*|\b\w+\s*[:=]\s*["']?\w+["']?/g, "");
      const familiar=new Set((readerProfile.terms||[]).flatMap(term=>String(term).toLowerCase().match(/[a-z]+/g)||[]));
      const generic = [...prose.matchAll(UNTRANSLATED_RUSSIAN_GENERIC)].map((match) => match[0].toLowerCase()).filter(term=>!familiar.has(term));
      if (generic.length) issues.push(`${field} contains untranslated generic terms: ${[...new Set(generic)].join(", ")}`);
    }
    if (/^en(?:-|$)/.test(language) && /[А-Яа-яЁё]/.test(text)) issues.push(`${field} must use English owner-facing language`);
  }
  return issues;
}

export function validateArchitectureLanguage(value, language, readerProfile) {
  const issues = architectureLanguageIssues(value, language, readerProfile);
  if (issues.length) throw new Error(`Visible language '${language}' failed: ${issues.slice(0, 16).join("; ")}`);
  return value;
}

export function applyKnownVocabulary(value,language,profile={}) {
  if(!/^ru(?:-|$)/.test(language))return value;
  const glossary={runtime:"среда запуска",workflow:"рабочий процесс",feedback:"обратная связь",correction:"поправка",corrections:"поправки",proposed:"предложено",output:"результат",request:"запрос",response:"ответ",pipeline:"цепочка обработки",handler:"обработчик",store:"хранилище",adapter:"адаптер",engine:"механизм",router:"маршрутизатор",status:"статус",signal:"сигнал",signals:"сигналы",override:"ручная настройка",overrides:"ручные настройки"};
  const fields=languageRepairFields(value,language,profile);
  if(!fields.length)return value;
  const edits=fields.map(({field,text})=>({field,text:text.replace(/`[^`]*`|[\w./-]+\.(?:[cm]?jsx?|tsx?|py|md|json|toml)|\b(?:runtime|workflow|feedback|corrections?|proposed|output|request|response|pipeline|handler|store|adapter|engine|router|status|signals?|overrides?)\b/gi,word=>glossary[word.toLowerCase()]||word)}));
  return applyLanguageRepair(value,edits,fields);
}

export function languageRepairFields(value,language,profile) {
  const issues=architectureLanguageIssues(value,language,profile);
  return visibleFields(value).filter(([field])=>issues.some(issue=>issue.startsWith(`${field} `))).map(([field,text])=>({field,text}));
}

export function applyLanguageRepair(value,edits,allowedFields) {
  const next=structuredClone(value),allowed=new Set(allowedFields.map(item=>item.field)),seen=new Set();
  for(const {field,text} of edits) {
    if(!allowed.has(field)||seen.has(field)||typeof text!=="string"||!text.trim())throw new Error("Языковая правка вышла за пределы выбранных фраз");
    seen.add(field);
    if(field.startsWith("map."))next[field.slice(4)]=text;
    else if(field.startsWith("unresolvedQuestions."))next.unresolvedQuestions[Number(field.split(".")[1])]=text;
    else {
      const groups={area:next.areas,entity:next.entities,relation:next.relations,flow:next.keyFlows};
      const scope=field.slice(0,field.indexOf(".")),key=field.slice(field.lastIndexOf(".")+1),id=field.slice(scope.length+1,field.lastIndexOf("."));
      const item=groups[scope]?.find(item=>item.id===id);if(!item)throw new Error("Элемент языковой правки не найден");item[key]=text;
    }
  }
  if(seen.size!==allowed.size)throw new Error("Исправлены не все выбранные фразы");
  return next;
}

export function refinementFragment(value,review) {
  const issues=(review.issues||[]).filter(issue=>issue.severity==="critical");
  if(issues.some(issue=>issue.scope==="map"))return null;
  const names={area:"areas",entity:"entities",relation:"relations",flow:"keyFlows"};
  const fragment={};
  for(const [scope,key] of Object.entries(names)){
    const ids=new Set(issues.filter(issue=>issue.scope===scope).map(issue=>issue.id));
    if(ids.size)fragment[key]=(value[key]||[]).filter(item=>ids.has(item.id));
  }
  return Object.keys(fragment).length?fragment:null;
}

export function mergeRefinementFragment(value,fragment,expected) {
  const flowRelations=Boolean(expected.keyFlows&&!expected.relations);
  if(Object.keys(fragment).some(key=>!Object.hasOwn(expected,key)&&!(flowRelations&&key==="relations")))throw new Error("Уточнение вышло за пределы выбранных объектов");
  const next=structuredClone(value);
  for(const key of Object.keys(expected)){
    if(!Array.isArray(fragment[key])||!sameIds(expected[key],fragment[key],"id"))throw new Error("Уточнение изменило состав выбранных объектов");
    const replacements=new Map(fragment[key].map(item=>{
      if(key!=="keyFlows")return[item.id,item];
      const original=value.keyFlows.find(flow=>flow.id===item.id);
      const {transitionMode,...edit}=item;
      if(transitionMode==="append")edit.transitions=[...(original.transitions||[]),...(edit.transitions||[])];
      if(transitionMode==="conditions"){
        const conditions=new Map(edit.transitions.map(item=>[item.relationId,item.condition]));
        if([...conditions.keys()].some(id=>!original.transitions.some(item=>item.relationId===id)))throw new Error("Правка условия не может добавить переход");
        edit.transitions=original.transitions.map(item=>conditions.has(item.relationId)?{...item,condition:conditions.get(item.relationId)}:item);
      }
      return[item.id,{...original,...edit}];
    }));next[key]=next[key].map(item=>replacements.get(item.id)||item);
  }
  if(flowRelations&&fragment.relations?.length){
    const used=new Set(next.keyFlows.filter(flow=>expected.keyFlows.some(item=>item.id===flow.id)).flatMap(flow=>(flow.transitions||[]).map(item=>item.relationId)));
    const relevant=fragment.relations.filter(item=>used.has(item.id));
    if(relevant.filter(item=>!value.relations.some(old=>old.id===item.id)).length>6)throw new Error("Слишком много новых связей для одной поправки");
    const merged=new Map(next.relations.map(item=>[item.id,item]));for(const item of relevant)merged.set(item.id,item);next.relations=[...merged.values()];
  }
  const relations=new Map(next.relations.map(item=>[item.id,item]));
  for(const flow of next.keyFlows||[])if(expected.keyFlows?.some(item=>item.id===flow.id)&&flow.transitions?.length){
    const edges=flow.transitions.map(item=>relations.get(item.relationId));
    if(edges.some(item=>!item)||edges.some((item,index)=>index>0&&edges[index-1].to!==item.from))throw new Error("Переходы сценария не соединяются в последовательный путь");
    flow.steps=[edges[0].from,...edges.map(item=>item.to)];
  }
  return next;
}

function refinementFragmentSchema(fragment,value) {
  const properties=Object.fromEntries(Object.entries(fragment).map(([key,items])=>{
    const schema=structuredClone(ARCHITECT_OUTPUT_SCHEMA.properties[key]);schema.items.properties.id.enum=items.map(item=>item.id);
    if(key==="keyFlows"){delete schema.items.properties.steps;schema.items.properties.transitionMode={type:"string",enum:["replace","append","conditions"]};schema.items.required=schema.items.required.filter(key=>key!=="steps").concat("transitionMode");}
    return[key,schema];
  }));
  if(fragment.keyFlows&&!fragment.relations){properties.relations={...structuredClone(ARCHITECT_OUTPUT_SCHEMA.properties.relations),maxItems:6};for(const key of ["from","to"])properties.relations.items.properties[key].enum=value.entities.map(item=>item.id);}
  return {type:"object",additionalProperties:false,properties,required:Object.keys(properties)};
}

function flowTextSchema(flow) {
  return {type:"object",additionalProperties:false,properties:{title:{type:"string"},trigger:{type:"string"},outcome:{type:"string"},needsTopologyChange:{type:"boolean"},conditions:{type:"object",additionalProperties:false,properties:Object.fromEntries(flow.transitions.map(item=>[item.relationId,{type:"string"}])),required:flow.transitions.map(item=>item.relationId)}},required:["title","trigger","outcome","needsTopologyChange","conditions"]};
}

export function mergeFlowText(flow,edit) {
  return {...flow,title:edit.title,trigger:edit.trigger,outcome:edit.outcome,transitions:flow.transitions.map(item=>({...item,condition:edit.conditions[item.relationId]}))};
}

function localReferenceCandidates(reference) {
  const normalized = String(reference || "").trim().replace(/#L\d+(?:C\d+)?$/i, "");
  if (!normalized || /^[a-z]+:\/\//i.test(normalized)) return [];
  const candidates = [normalized];
  const symbol = normalized.lastIndexOf(":");
  if (symbol > 1) candidates.push(normalized.slice(0, symbol));
  return [...new Set(candidates)];
}

function looksLikeLocalReference(reference) {
  return /[\\/]/.test(reference) || /\.[A-Za-z0-9]{1,8}(?::|#|$)/.test(reference);
}

export function architectureEvidenceIssues(value, root) {
  if (!root) return [];
  const issues = [];
  const check = (scope, id, reference) => {
    if(String(reference).startsWith("dialog:")) {
      try {readDialogSource(root,reference);} catch(error) {issues.push(`${scope}.${id}: ${error.message}`);}
      return;
    }
    if (!looksLikeLocalReference(String(reference || ""))) return;
    const source=readCodeSource(root,String(reference).replace(/#L(\d+)(?:-L?(\d+))?$/,(_,first,last)=>":"+first+(last?"-"+last:"")));
    if(source.error) issues.push(`${scope}.${id} references invalid evidence '${reference}': ${source.error}`);
  };
  for (const area of value.areas || []) for (const evidence of area.evidence || []) check("area", area.id, evidence);
  for (const entity of value.entities || []) {
    if (entity.path) check("entity", entity.id, entity.path);
    for (const evidence of entity.evidence || []) check("entity", entity.id, evidence);
  }
  for (const relation of value.relations || []) for (const evidence of relation.evidence || []) check("relation", relation.id, evidence);
  return issues;
}

export function validateArchitectureEvidence(value, root) {
  const issues = architectureEvidenceIssues(value, root);
  if (issues.length) throw new Error(`Repository evidence failed: ${issues.slice(0, 16).join("; ")}`);
  return value;
}

function compactReviewMap(value) {
  return {
    projectTitle: value.projectTitle, projectSummary: value.projectSummary,
    layoutIntent: value.layoutIntent, keyFlows: value.keyFlows,
    areas: value.areas.map(({ id, title, note, order }) => ({ id, title, note, order })),
    entities: value.entities.map(({ id, areaId, parentId, label, kind, status, purpose, note }) => ({ id, areaId, parentId, label, kind, status, purpose, note })),
    relations: value.relations.map(({ id, from, to, label, status }) => ({ id, from, to, label, status })),
  };
}

export function architectureReviewSchema(value) {
  const schema = structuredClone(ARCHITECT_REVIEW_SCHEMA);
  schema.properties.issues.items.properties.id = {
    ...schema.properties.issues.items.properties.id,
    enum: [...new Set(["map", ...value.areas.map((item) => item.id), ...value.entities.map((item) => item.id), ...value.relations.map((item) => item.id), ...(value.keyFlows || []).map((item) => item.id)])],
  };
  return schema;
}

export function validateReviewerDecision(value, review) {
  const ids = {
    map: new Set(["map"]), area: new Set(value.areas.map((item) => item.id)), entity: new Set(value.entities.map((item) => item.id)),
    relation: new Set(value.relations.map((item) => item.id)), flow: new Set((value.keyFlows || []).map((item) => item.id)),
  };
  for (const issue of review.issues || []) if (!ids[issue.scope]?.has(issue.id)) throw new Error(`Reviewer issue '${issue.id}' does not match scope '${issue.scope}'`);
  const critical = (review.issues || []).filter((issue) => issue.severity === "critical");
  if (review.passed && critical.length) throw new Error("Reviewer marked the map passed while reporting critical issues");
  if (!review.passed && !critical.length) throw new Error("Reviewer rejected the map without a critical issue");
  return review;
}

export function architectReviewPrompt(value, language, readerProfile = {}) {
  return `You review whether this project map helps its owner recover context. You receive only the map and reader profile, with no repository access. Do not use tools or infer undocumented implementation.
Use ${language === "ru" ? "Russian" : language === "en" ? "English" : "the map's language"}.
Reader profile: ${JSON.stringify(readerProfile)}

Answer from the map:
1. What is the product for, what goes in, and what useful result comes out?
2. Which responsibilities/modules participate, and why do they exist?
3. How does a principal function reach its result, including meaningful conditions and failures?
The owner should also see what is implemented, planned or unknown.

A critical issue must prevent one of these tasks or create a materially wrong mental model: contradictory responsibilities/statuses, an unintelligible core module, a missing essential path, or genuinely duplicated functions presented as separate capabilities. Pass when these tasks are possible.
Do not block a useful map over style preferences, optional detail or a preferred architecture school. An area may legitimately contain one module, including one planned capability. Similar area/module names at different zoom levels are not automatically duplicated functionality. Do not demand extra unsupported nodes to fill an area.
Respect the graph contract: every non-person entity belongs to an area, parents are acyclic within an area, people stay outside areas, directed transitions use existing relations. Any recommendation must be possible within this contract. Consolidation means moving modules into an appropriate existing area, not detaching normal modules into empty areaId.
Interpret ordinary wording in the owner's domain context. Technical spelling belongs in details; do not force it into clear product language. Potential wording improvements are warnings.
For an owner explicitly using product/process framing, a principal explanation that requires understanding internal function names or mentally executing program code is a comprehension problem, not merely a style preference. Explain the result and causal role in their terms; official product names may remain unchanged.
Give short, specific recommendations anchored to existing map ids; map-wide issues use id="map". passed=false requires at least one critical issue; warnings do not fail a map. Return the required JSON.

Map:
${JSON.stringify(compactReviewMap(value))}`;
}

export function architectRefinementPrompt({ value, review, scopeError = "" }) {
  return `Continue the same Repo Canvas Architect session. An independent reviewer has inspected your candidate without repository access.

Refine only the concrete fragments named by the review and the minimum adjacent relations/keyFlows needed to keep them coherent. Reuse the repository evidence already collected in this session. Do not inspect files, run tools, reread the repository or rebuild unrelated areas. You may split, merge, rename, add or remove entities inside an affected area when that is necessary to make one responsibility clear. Preserve every unaffected area, entity, relation, flow, id, color and wording exactly.

${scopeError ? `Your previous refinement exceeded that scope and was rejected before review:\n${scopeError}\n` : ""}
Independent review:
${JSON.stringify(review)}

Current candidate:
${JSON.stringify(value)}

Return the complete corrected structured map only.`;
}

function normalizeUsage(usage = {}) {
  const number = (...keys) => keys.map((key) => Number(usage?.[key])).find(Number.isFinite) || 0;
  const inputTokens = number("input_tokens", "inputTokens");
  const cachedInputTokens = number("cached_input_tokens", "cachedInputTokens");
  const outputTokens = number("output_tokens", "outputTokens");
  return { inputTokens, cachedInputTokens, outputTokens, totalTokens: number("total_tokens", "totalTokens") || inputTokens + outputTokens };
}

function addUsage(total, usage) {
  for (const key of Object.keys(total)) total[key] += usage[key] || 0;
}

function createArchitectAudit(root) {
  const runId = crypto.randomUUID();
  const file = path.join(resolveDataDirectory(root), "architect-runs.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const append = (type, payload = {}) => fs.appendFileSync(file, `${JSON.stringify({ v: 1, runId, ts: new Date().toISOString(), type, ...payload })}\n`, { encoding: "utf8", mode: 0o600 });
  return { runId, file, append };
}

function retainedIds(snapshot, value) {
  const removedAreas = new Set(value.removedAreaIds || []);
  const removedEntities = new Set(value.removedEntityIds || []);
  const areaIds = [...new Set([
    ...snapshot.areas.filter((item) => !removedAreas.has(item.id)).map((item) => item.id),
    ...value.areas.map((item) => item.id),
  ])];
  const entityIds = [...new Set([
    ...snapshot.entities.filter((item) => !removedEntities.has(item.id) && !removedAreas.has(item.areaId)).map((item) => item.id),
    ...value.entities.map((item) => item.id),
  ])];
  return { areaIds, entityIds };
}

export function architectureRepairSchema(value, snapshot) {
  const schema = structuredClone(ARCHITECT_OUTPUT_SCHEMA);
  const ids = retainedIds(snapshot, value);
  const restrict=(array,values,field)=>{
    const unique=[...new Set(values)];
    if(!unique.length){array.maxItems=0;return;}
    if(field)array.items.properties[field]={...array.items.properties[field],enum:unique};
    else array.items={...array.items,enum:unique};
  };
  const {areas,entities,relations,keyFlows,removedAreaIds,removedEntityIds,removedRelationIds}=schema.properties;
  restrict(areas,value.areas.map(item=>item.id),'id');
  restrict(entities,value.entities.map(item=>item.id),'id');
  restrict(entities,['',...ids.areaIds],'areaId');
  restrict(entities,['',...ids.entityIds],'parentId');
  restrict(relations,value.relations.map(item=>item.id),'id');
  restrict(relations,ids.entityIds,'from');restrict(relations,ids.entityIds,'to');
  restrict(keyFlows.items.properties.transitions,[...snapshot.relations.filter(item=>!(value.removedRelationIds||[]).includes(item.id)),...value.relations].map(item=>item.id),'relationId');
  restrict(removedAreaIds,snapshot.areas.map(item=>item.id));
  restrict(removedEntityIds,snapshot.entities.map(item=>item.id));
  restrict(removedRelationIds,snapshot.relations.map(item=>item.id));
  return schema;
}

export function architectRepairPrompt({ value, snapshot, error, language }) {
  const ids = retainedIds(snapshot, value);
  return `You are repairing a completed Repo Canvas architecture result after deterministic validation failed.

The expensive repository inspection is already complete. Do not inspect files, run tools, add research or redesign the map. Return corrected structured JSON only.

Validation error:
${error.message}

Repair contract:
- preserve the exact area, entity and relation id sets from the candidate;
- preserve the exact removal id sets;
- use only the allowed retained ids below for areaId, parentId, relation endpoints and keyFlow steps;
- a keyFlow step must be a real map entity id; remove conceptual action ids from steps and express that action in trigger/outcome text;
- repair every occurrence of the same defect, not only the first reported occurrence;
- preserve evidence, domain meaning, owner language and all otherwise valid content;
- target visible language is ${language || "the candidate's established owner language"}; translate generic framework jargon in titles, descriptions and relation labels into plain owner-facing wording while keeping product names, code ids, contracts and protocols intact;
- rerun the six preflight checks from the Architect contract before returning JSON.

Allowed area ids: ${JSON.stringify(ids.areaIds)}
Allowed entity ids: ${JSON.stringify(ids.entityIds)}

Candidate JSON:
${JSON.stringify(value)}`;
}

function assertRepairScope(before, after) {
  for (const [field, idField] of [["areas", "id"], ["entities", "id"], ["relations", "id"]]) {
    if (!sameIds(before[field], after[field], idField)) throw new Error(`Architect repair changed the ${field} id set`);
  }
  for (const field of ["removedAreaIds", "removedEntityIds", "removedRelationIds"]) {
    if (!sameIds(before[field], after[field], "id")) throw new Error(`Architect repair changed ${field}`);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function itemMap(items = []) {
  return new Map(items.map((item) => [item.id, item]));
}

export function assertReviewRepairScope(before, after, review) {
  const issues = (review.issues || []).filter((issue) => issue.severity === "critical");
  if (issues.some((issue) => issue.scope === "map")) return;
  const beforeAreas = itemMap(before.areas); const afterAreas = itemMap(after.areas);
  const beforeEntities = itemMap(before.entities); const afterEntities = itemMap(after.entities);
  const beforeRelations = itemMap(before.relations); const afterRelations = itemMap(after.relations);
  const beforeFlows = itemMap(before.keyFlows); const afterFlows = itemMap(after.keyFlows);
  const allowedAreas = new Set(); const directlyTargetedEntities = new Set(); const targetedRelations = new Set(); const targetedFlows = new Set();
  const addEntityArea = (id) => {
    const entity = beforeEntities.get(id) || afterEntities.get(id);
    if (entity) directlyTargetedEntities.add(id);
    if (entity?.areaId) allowedAreas.add(entity.areaId);
  };
  for (const issue of issues) {
    if (issue.scope === "area") allowedAreas.add(issue.id);
    if (issue.scope === "entity") addEntityArea(issue.id);
    if (issue.scope === "relation") {
      targetedRelations.add(issue.id);
      const relation = beforeRelations.get(issue.id) || afterRelations.get(issue.id);
      if (relation) { addEntityArea(relation.from); addEntityArea(relation.to); }
    }
    if (issue.scope === "flow") {
      targetedFlows.add(issue.id);
      const flow = beforeFlows.get(issue.id) || afterFlows.get(issue.id);
      for (const step of flow?.steps || []) addEntityArea(step);
    }
  }
  const allowedEntities = new Set([...directlyTargetedEntities, ...[...before.entities, ...after.entities].filter((item) => allowedAreas.has(item.areaId)).map((item) => item.id)]);
  const unchanged = (label, beforeMap, afterMap, allowed) => {
    for (const id of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
      if (allowed(id)) continue;
      if (!sameJson(beforeMap.get(id), afterMap.get(id))) throw new Error(`Focused refinement changed unrelated ${label} '${id}'`);
    }
  };
  unchanged("area", beforeAreas, afterAreas, (id) => allowedAreas.has(id));
  unchanged("entity", beforeEntities, afterEntities, (id) => allowedEntities.has(id));
  unchanged("relation", beforeRelations, afterRelations, (id) => {
    const relation = beforeRelations.get(id) || afterRelations.get(id);
    return targetedRelations.has(id) || allowedEntities.has(relation?.from) || allowedEntities.has(relation?.to);
  });
  unchanged("flow", beforeFlows, afterFlows, (id) => {
    const flow = beforeFlows.get(id) || afterFlows.get(id);
    return targetedFlows.has(id) || (flow?.steps || []).some((step) => allowedEntities.has(step));
  });
  unchanged("removed area", new Map((before.removedAreaIds || []).map((id) => [id, id])), new Map((after.removedAreaIds || []).map((id) => [id, id])), (id) => allowedAreas.has(id));
  unchanged("removed entity", new Map((before.removedEntityIds || []).map((id) => [id, id])), new Map((after.removedEntityIds || []).map((id) => [id, id])), (id) => allowedEntities.has(id));
  unchanged("removed relation", new Map((before.removedRelationIds || []).map((id) => [id, id])), new Map((after.removedRelationIds || []).map((id) => [id, id])), (id) => {
    const relation = beforeRelations.get(id) || afterRelations.get(id);
    return targetedRelations.has(id) || allowedEntities.has(relation?.from) || allowedEntities.has(relation?.to);
  });
  for (const field of ["projectTitle", "projectSummary", "layoutIntent", "layoutDirection", "unresolvedQuestions"]) {
    if (!sameJson(before[field], after[field])) throw new Error(`Focused refinement changed unrelated map field '${field}'`);
  }
}

export async function runArchitect({
  root = projectRoot,
  refresh = false,
  viewpoint = "",
  language: requestedLanguage = "",
  model,
  effort,
  runner = runStructured,
  reviewer = runStructured,
  evidenceReviewer = runner === runStructured ? runStructured : null,
  collectSources = runner === runStructured,
  sourceOptions = {},
  signal,
  maxModelCalls,
  maxModelTokens,
  resumeCandidate = runner === runStructured,
  onProgress,
  maxRepairs = 3,
  maxReviewRepairs = 3,
  sessionFactory = null,
} = {}) {
  const audit = createArchitectAudit(root);
  const snapshot = getSnapshot();
  if(snapshot.storeErrors?.length)throw new Error("Журнал проекта повреждён. Сначала выполните check и восстановление с резервной копией; модель не запускалась.");
  if (requestedLanguage && !normalizeLanguageTag(requestedLanguage)) throw new Error(`Invalid language tag '${requestedLanguage}'; use a BCP 47 tag such as ru, en or de-DE`);
  let language = preferredMapLanguage(viewpoint, snapshot, repositoryLanguageSample(root), requestedLanguage);
  const runtime=readRuntimeConfig();
  const callLimit=maxModelCalls ?? runtime.maxModelCalls ?? 14;
  const tokenLimit=maxModelTokens ?? runtime.maxModelTokens ?? 300000;
  let knowledge=snapshot.map?.knowledge || readProjectKnowledge(root);
  let preparedSources=null;let verifiedSources=null;let evidenceReviews=0;let modules=null;
  const revision=codeState(root);
  const candidateFile=path.join(resolveDataDirectory(root),"architect-candidate.json");
  const signature=crypto.createHash("sha256").update(JSON.stringify(repositoryFiles(root).map(file=>{const stat=fs.statSync(path.join(root,file));return [file,stat.size,stat.mtimeMs];}))).digest("hex");
  let cached=null;
  if(resumeCandidate) {try {cached=readSourceJson(candidateFile,null);}catch {/* a damaged candidate can be rebuilt */}}
  const sourcePolicy=JSON.stringify({dialogSources:runtime.dialogSources!==false,providers:runtime.providers,excluded:runtime.excludedSourceFiles||[],aliases:runtime.projectAliases||[],sourceOptions});
  if(cached?.sourcePolicy!==sourcePolicy)cached=null;
  const baseSemanticSignature=semanticSignature(snapshot);
  if(cached && ((cached.baseSemanticSignature?cached.baseSemanticSignature!==baseSemanticSignature:cached.baseRevision!==snapshot.revision) || cached.viewpoint!==viewpoint || cached.language!==language || cached.status==="applied")) cached=null;
  const sourcesChanged=Boolean(cached&&cached.signature!==signature);
  if(sourcesChanged){
    cached.evidenceApproved=false;cached.verifiedSources=null;cached.preparedSources=sourcePackage(root,(cached.preparedSources?.sources||[]).map(source=>source.reference).filter(Boolean),{recoverRanges:true});
    const refreshRange=reference=>{if(!/:\d+(?:[-:]\d+)?$/.test(reference||""))return reference;const current=readCodeSource(root,reference);if(!current.error)return reference;const file=reference.replace(/:\d+(?:[-:]\d+)?$/,"");return readCodeSource(root,file).text?file:reference;};
    for(const item of [...cached.value.areas,...cached.value.entities,...cached.value.relations]){if(item.path)item.path=refreshRange(item.path);item.evidence=(item.evidence||[]).map(refreshRange);}
  }
  let evidenceApproved=Boolean(cached?.evidenceApproved);
  let pendingReview=cached?.pendingReview?{value:cached.pendingReview}:null;let evidenceExtraRefs=cached?.evidenceExtraRefs||[];let evidenceReads=0;
  let pendingEvidence=sourcesChanged?null:cached?.pendingEvidence||null;
  let acceptedEvidence=sourcesChanged?[]:cached?.acceptedEvidence||[];
  if(evidenceApproved) verifiedSources=cached.verifiedSources;
  let lastVerified=cached?.evidenceApproved?{value:structuredClone(cached.value),sources:cached.verifiedSources}:null;
  const saveCandidate=(value,approved=false,review=pendingReview?.value||null)=>{evidenceApproved=approved;if(approved)lastVerified={value:structuredClone(value),sources:structuredClone(verifiedSources)};if(resumeCandidate)writeSourceJson(candidateFile,{value,signature,sourcePolicy,auditRunId:audit.runId,baseRevision:snapshot.revision,baseSemanticSignature,viewpoint,language,knowledge:publicKnowledge(knowledge),preparedSources,verifiedSources:approved?verifiedSources:null,evidenceExtraRefs,pendingEvidence,acceptedEvidence,evidenceApproved:approved,pendingReview:review,status:"candidate",updatedAt:new Date().toISOString()});};
  const profile = runner === runStructured ? selectModelProfile("architect",{profile:{model,effort}}) : {model:model||MODEL_PROFILES.architect.model,effort:effort||MODEL_PROFILES.architect.effort};
  let activeArchitectProfile=profile;
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const calls = [];
  let solSession = null;
  let result = null;
  let value = null;
  let repairs = 0;
  let acceptanceRepairs = 0;
  let semanticReviews = 0;
  let languageRepairs = 0;
  let reviewWarnings = 0;
  const threadIds = [];
  const reviewThreadIds = [];
  const summary = () => ({ runId: audit.runId, auditFile: audit.file, calls: calls.length, models:[...new Set(calls.map(call=>call.model).filter(Boolean))], usage: { ...usage }, repairs, acceptanceRepairs, semanticReviews });
  const callModel = async (callRunner, phase, options) => {
    if(signal?.aborted) throw new Error("Построение отменено");
    if(["initial","structural-repair","acceptance-refinement"].includes(phase))options={...options,prompt:options.prompt+`\nOwner-facing text remains in ${language}. Reader profile: ${JSON.stringify(knowledge.profile)}. Owner viewpoint: ${viewpoint}. Keep changed labels, purposes and flow outcomes concise and understandable from this viewpoint. A flow outcome states the product result in one short sentence; it is not a debugging trace. Put API paths, function names, storage fields and implementation vocabulary in technicalName/evidence or technical notes, not ordinary product explanations. Preserve precise behaviour and protected owner wording. Prefer 1–2 short sentences for purposes and at most three essential input/output/criterion items. Do not fill optional fields with exhaustive API fields, timers, limits or speculative requirements. Runtime components may own model calls and local orchestration; distinguish that capability from the model actor itself. Show causal responsibility flows at the owner's chosen level, with implementation details available through evidence.`};
    if(callRunner===runStructured) {
      const retry=phase==="acceptance-refinement"&&acceptanceRepairs>1 || (phase==="structural-repair" && repairs>1);
      const complexity=taskComplexity(options.role,{promptChars:options.prompt?.length||0,retry});
      const selected=selectModelProfile(options.role,{config:runtime,profile:options.role==="architect"?{model,effort}:undefined,complexity,contextTokens:Math.ceil((options.prompt?.length||0)/2)+16000});
      selected.reason+=complexity==="hard" ? (retry?"; исправление проверенного противоречия":"; большой пакет источников") : "; обычный объём";
      if(options.session && ["provider","model","effort"].some(key=>options.session.profile?.[key]!==selected[key])) {
        await solSession.close(); solSession=await createProviderSession({cwd:root,profile:selected});
        options={...options,session:solSession};
      }
      options={...options,profile:selected,complexity};
    }
    const promptText=options.prompt||"";const nonAscii=(promptText.match(/[^\x00-\x7f]/g)||[]).length;
    const estimate=Math.ceil((promptText.length-nonAscii)/3.1+nonAscii/1.8)+16000+(options.session?.estimatedContextTokens||0);
    if(calls.length>=callLimit || usage.totalTokens + estimate>tokenLimit) throw new Error("Достигнут предел расхода построения. Сохранённые знания доступны; увеличьте лимит или сузьте охват.");
    const index = calls.length + 1; const startedAt = new Date().toISOString(); const started = Date.now();
    try {
      const visiblePhase = phase === "source-selection" ? "sources" : phase === "structural-repair" ? "repairing" : phase === "acceptance-refinement" ? "refining" : options.role === "historian" ? "knowledge" : options.role === "architect" ? "building" : options.role === "reviewer" ? "reviewing" : "evidence";
      const progress = event => onProgress?.({...event, phase: visiblePhase, model: options.profile?.model || null, call: index});
      progress({eventType:"process.requested",at:startedAt});
      const response = await callRunner({...options,usageRoot:root,signal,onProgress:progress});
      if(options.role==="architect") {activeArchitectProfile=response.profile||options.profile||activeArchitectProfile;if(response.threadId)threadIds.push(response.threadId);}
      const callUsage = normalizeUsage(response.usage);
      if(!response.usage){callUsage.inputTokens=estimate;callUsage.totalTokens=estimate;callUsage.estimated=true;}
      if(options.session)options.session.estimatedContextTokens=callUsage.inputTokens+callUsage.outputTokens;
      addUsage(usage, callUsage);
      const record = {
        index, phase, role: options.role, model: response.profile?.model || options.profile?.model || MODEL_PROFILES[options.role]?.model,
        effort: response.profile?.effort || options.profile?.effort || MODEL_PROFILES[options.role]?.effort,
        provider:response.provider||response.profile?.provider||options.profile?.provider||null,selectionReason:response.profile?.reason||options.profile?.reason||null,
        threadId: response.threadId || null, resumed: response.resumed === true,
        startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, usage: callUsage,
      };
      calls.push(record); audit.append("model.completed", record);
      return response;
    } catch (error) {
      const record = { index, phase, role: options.role, model: options.profile?.model || MODEL_PROFILES[options.role]?.model, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, error: String(error?.message || error).slice(0, 1000) };
      calls.push(record); audit.append("model.failed", record); throw error;
    }
  };
  audit.append("run.started", { refresh, viewpoint, language, architect: profile, reviewer: MODEL_PROFILES.reviewer });
  try {
    solSession = sessionFactory
      ? await sessionFactory({ cwd: root, profile })
      : runner === runStructured
        ? await createProviderSession({cwd:root,profile})
        : runner === runCodexStructured
        ? await createCodexStructuredSession({ cwd: root, profile })
        : { cwd: root, profile, threadId: null, turns: 0, closed: false, close: async () => {} };
    if(cached) {knowledge=cached.knowledge;preparedSources=cached.preparedSources;value=cached.value;result={value,profile,provider:profile.provider};}
    if(collectSources && !cached) {
      const collected=await collectProjectKnowledge(root,{
        language,ownerInstructions:viewpoint,signal,onProgress,
        sourceOptions:{providers:runtime.providers,enabled:runtime.dialogSources!==false,excludeFiles:runtime.excludedSourceFiles||[],projectAliases:runtime.projectAliases||[],...sourceOptions},
        maxBatches:Math.max(0,Math.min(4,callLimit-5)),
        call:options=>usage.totalTokens + Math.ceil(options.prompt.length/2) + 8000 > Math.min(tokenLimit*.2,36000) ? null : callModel(runner,"knowledge",options),
      });
      knowledge=collected.knowledge;
      if(!requestedLanguage && !viewpoint && normalizeLanguageTag(knowledge.profile?.language)) language=normalizeLanguageTag(knowledge.profile.language);
      onProgress?.({phase:"sources",detail:"Сопоставляем изменённые модули и прямые импорты"});
      modules=buildModuleCards(root);
      modules=await enrichModuleCards(root,modules,options=>usage.totalTokens+Math.ceil(options.prompt.length/2)+8000>tokenLimit*.2?null:callModel(reviewer,"module-cards",options));
      preparedSources=sourcePackage(root,selectInitialReferences(root,modules,snapshot),{recoverRanges:true,compact:true,expandWholeFiles:false,maxChars:45000,maxSourceChars:8000});
    }
    if(!cached) result = await callModel(runner, "initial", {
      role: "architect", cwd: root, session: solSession, profile,
      prompt: architectPrompt({ snapshot, refresh, viewpoint, language }) + `\nReader profile, intent and decisions: ${JSON.stringify(publicKnowledge(knowledge))}\nUse this reader framing and vocabulary for titles and explanations. Preserve original technical identifiers in technicalName and code references; never change facts for the reader.\nCached module hints and static import candidates (not proof of behaviour): ${JSON.stringify(modules?moduleContext(modules):null)}\nOriginal source package: ${JSON.stringify(preparedSources)}`, outputSchema: ARCHITECT_OUTPUT_SCHEMA,
      onProgress: (progress) => onProgress?.({ ...progress, attempt: 0 }),
    });
    value = applyKnownVocabulary(normalizeArchitecture(result.value,snapshot),language,knowledge.profile);
    saveCandidate(value,evidenceApproved);
    if (result.threadId) threadIds.push(result.threadId);

    while (true) {
      let pendingError = null;
      while (true) {
        let validationError = pendingError; pendingError = null;
        if (!validationError) {
          try {
            onProgress?.({ phase: "validating", attempt: repairs + acceptanceRepairs, at: new Date().toISOString() });
            validateArchitecture(value, snapshot);
            const wording=languageRepairFields(value,language,knowledge.profile);
            if(wording.length&&languageRepairs<2) {
              const edited=await callModel(reviewer,"language-repair",{role:"reviewer",cwd:root,prompt:`Edit only these phrases into clear ${language} for the project owner. Keep meaning and actual product/technology names; translate generic jargon INCLUDING former node titles. For example, 'прежнего Runtime bootstrap' should be 'прежнего блока запуска'. Never preserve a rejected English phrase merely because it is capitalized. Return each field exactly once. Do not add facts. Rejected wording: ${JSON.stringify(architectureLanguageIssues(value,language,knowledge.profile))}. Phrases: ${JSON.stringify(wording)}`,outputSchema:{type:"object",additionalProperties:false,properties:{edits:{type:"array",items:{type:"object",additionalProperties:false,properties:{field:{type:"string",enum:wording.map(item=>item.field)},text:{type:"string"}},required:["field","text"]}}},required:["edits"]}});
              value=applyLanguageRepair(value,edited.value.edits,wording);languageRepairs++;saveCandidate(value);
              continue;
            }
            if(wording.length){const error=new Error("Не удалось исправить язык пояснений. Подготовленная карта сохранена для следующей попытки.");error.code="LANGUAGE_REPAIR_FAILED";throw error;}
            validateArchitectureLanguage(value, language, knowledge.profile);
            validateArchitectureEvidence(value, root);
            break;
          } catch (caught) { if(caught.code==="LANGUAGE_REPAIR_FAILED"||/предел расхода|timed out|aborted/i.test(caught.message))throw caught;validationError = caught; }
        }
        audit.append("validation.rejected", { attempt: repairs + 1, error: validationError.message });
        if (repairs >= maxRepairs) throw new Error(`Architect could not produce a valid map after ${repairs} focused structural repairs: ${validationError.message}`);
        repairs += 1;
        onProgress?.({ phase: "repairing", attempt: repairs + acceptanceRepairs, detail: validationError.message, at: new Date().toISOString() });
        const repaired = await callModel(runner, "structural-repair", {
          role: "architect", cwd: root, session: solSession,
          prompt: architectRepairPrompt({ value, snapshot, error: validationError, language }) + `\nOriginal sources and reader context: ${JSON.stringify({sources:preparedSources,knowledge:publicKnowledge(knowledge)})}`,
          outputSchema: architectureRepairSchema(value, snapshot), timeoutMs: 8 * 60_000, profile,
          onProgress: (progress) => onProgress?.({ ...progress, phase: progress.phase === "starting" ? "repairing" : progress.phase, attempt: repairs + acceptanceRepairs }),
        });
        try { const candidate=normalizeArchitecture(repaired.value,snapshot); validateArchitecture(candidate,snapshot); assertRepairScope(value,candidate); value=candidate;pendingEvidence=null;acceptedEvidence=[]; saveCandidate(value); }
        catch (scopeError) { pendingError = scopeError; }
      }

      let reviewed=pendingReview;pendingReview=null;
      if(evidenceReviewer && !evidenceApproved && !reviewed) {
        if(pendingEvidence)assertEvidenceUnchanged(root,{sources:acceptedEvidence});
        const reviewValue=pendingEvidence?focusEvidenceMap(value,pendingEvidence.issues.filter(issue=>issue.severity==="critical")):value;
        verifiedSources=evidencePackage(root,reviewValue,{extraRefs:[...(pendingEvidence?.sourceRequests||evidenceExtraRefs),...(!pendingEvidence?[...(knowledge.intentSourceIds||[]),...(knowledge.decisions||[]).flatMap(item=>item.sourceIds||[])]:[])]});
        if(sourcesChanged){const known=new Set(verifiedSources.sources.map(source=>source.reference));let chars=verifiedSources.sources.reduce((sum,source)=>sum+(source.text?.length||0),0);for(const source of preparedSources?.sources||[])if(source.text&&!known.has(source.reference)&&chars+source.text.length<=140000){verifiedSources.sources.push(source);chars+=source.text.length;known.add(source.reference);}}
        onProgress?.({phase:"evidence",attempt:repairs+acceptanceRepairs,detail:"Сверяем утверждения с исходниками"});
        const checked=await callModel(evidenceReviewer,"evidence-review",{role:"verifier",cwd:root,prompt:evidenceReviewPrompt(reviewValue,verifiedSources,pendingEvidence?{profile:knowledge.profile,coverage:knowledge.coverage,ownerViewpoint:viewpoint}:{...publicKnowledge(knowledge),ownerViewpoint:viewpoint})+(pendingEvidence?`\nContinuation of the same verification on unchanged sources. Other claims were accepted in the previous pass. Resolve only these remaining issues using the requested excerpts; do not reopen unrelated components or expand scope: ${JSON.stringify(pendingEvidence.issues.filter(issue=>issue.severity==="critical"))}`:sourcesChanged?"\nThis candidate predates source changes. Recheck its claims against current source excerpts. Report changed contracts within the owner's scope; do not expand that scope.":""),outputSchema:EVIDENCE_REVIEW_SCHEMA,timeoutMs:5*60_000});
        audit.append("evidence.completed",checked.value);
        evidenceReviews++;
        const requested=(checked.value.sourceRequests||[]).filter(reference=>!evidenceExtraRefs.includes(reference)).slice(0,6);
        if(requested.length&&evidenceReads<2&&(!checked.value.passed||checked.value.issues.some(issue=>issue.severity!=="warning"))){acceptedEvidence=[...new Map([...acceptedEvidence,...verifiedSources.sources].map(source=>[source.reference||source.id,source])).values()];pendingEvidence=checked.value.issues.some(issue=>issue.severity==="critical")?checked.value:null;evidenceExtraRefs=[...new Set([...requested,...evidenceExtraRefs])].slice(0,64);evidenceReads++;onProgress?.({phase:"sources",detail:"Дочитываем конкретные основания перед проверкой"});saveCandidate(value,false);continue;}

        if(checked.value.passed && !checked.value.issues.some(issue=>issue.severity!=="warning")){verifiedSources={...verifiedSources,sources:[...new Map([...acceptedEvidence,...verifiedSources.sources].map(source=>[source.reference||source.id,source])).values()]};pendingEvidence=null;saveCandidate(value,true);}
        if(!checked.value.passed || checked.value.issues.some(issue=>issue.severity!=="warning")) reviewed={...checked,value:{passed:false,summary:checked.value.summary,answers:{project:"",composition:"",lifecycle:""},issues:checked.value.issues.filter(issue=>issue.severity!=="warning").map(issue=>({...issue,severity:"critical"}))}};
      }
      if(!reviewed) {
        const reviewDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "repo-canvas-review-"));
        try {
          onProgress?.({ phase: "reviewing", attempt: repairs + acceptanceRepairs, at: new Date().toISOString() });
          reviewed = await callModel(reviewer, "owner-review", {
            role: "reviewer", cwd: reviewDirectory,
            prompt: architectReviewPrompt(value, language, {...knowledge.profile,explicitInstructions:[...(knowledge.profile.explicitInstructions||[]),...(viewpoint?[viewpoint]:[])]}), outputSchema: architectureReviewSchema(value), timeoutMs:3*60_000,
            onProgress: progress=>onProgress?.({...progress,phase:"reviewing",attempt:repairs+acceptanceRepairs}),
          });
        } finally {fs.rmSync(reviewDirectory,{recursive:true,force:true});}
      }
      semanticReviews += 1;
      validateReviewerDecision(value, reviewed.value);
      if (reviewed.threadId) reviewThreadIds.push(reviewed.threadId);
      const critical = (reviewed.value.issues || []).filter((issue) => issue.severity === "critical");
      reviewWarnings = (reviewed.value.issues || []).filter((issue) => issue.severity === "warning").length;
      audit.append("review.completed", { review: semanticReviews, passed: reviewed.value.passed, summary: reviewed.value.summary, answers: reviewed.value.answers, issues: reviewed.value.issues });
      if (reviewed.value.passed && !critical.length) break;
      pendingReview=reviewed;saveCandidate(value,evidenceApproved);pendingReview=null;
      if (acceptanceRepairs >= maxReviewRepairs) {
        const detail = critical.map((issue) => `${issue.scope}.${issue.id}: ${issue.message}`).join("; ") || reviewed.value.summary;
        throw new Error(`Owner-readability review rejected the map after ${semanticReviews} review(s) and ${acceptanceRepairs} focused refinements: ${detail}`);
      }

      const baseline = value; let scopeError = "";
      const issueIds=new Set((reviewed.value.issues||[]).map(issue=>issue.id));
      const issueEntities=new Set(value.keyFlows.filter(flow=>issueIds.has(flow.id)).flatMap(flow=>flow.steps||[]));
      const affected=[...value.areas,...value.entities,...value.relations].filter(item=>issueIds.has("map")||issueIds.has(item.id)||issueEntities.has(item.id));
      const mentioned=(reviewed.value.issues||[]).flatMap(issue=>[...(issue.message+" "+issue.recommendation).matchAll(/[\w./-]+\.(?:[cm]?jsx?|tsx?|py|md)(?::\d+(?:-\d+)?)?/g)].map(match=>match[0]));
      const fragment=refinementFragment(baseline,reviewed.value);
      const textFlow=fragment&&Object.keys(fragment).length===1&&fragment.keyFlows?.length===1&&new Set(fragment.keyFlows[0].transitions?.map(item=>item.relationId)).size===fragment.keyFlows[0].transitions?.length?fragment.keyFlows[0]:null;
      let requireTopologyChange=reviewed.value.topologyChangeRequested===true;
      const preciseMentioned=mentioned.map(reference=>{if(readCodeSource(root,reference).text)return reference;const [name,...range]=reference.split(":");const matches=repositoryFiles(root).filter(file=>file===name||file.endsWith("/"+name));return matches.length===1?matches[0]+(range.length?":"+range.join(":"):""):reference;});
      const refinementSources=sourcePackage(root,[...new Set([...preciseMentioned,...affected.flatMap(item=>[item.path,...(item.evidence||[])])].filter(Boolean))],{maxChars:fragment?40000:120000,maxSourceChars:fragment?12000:180000,compact:true,expandWholeFiles:!fragment,recoverRanges:true});
      while (true) {
        if (acceptanceRepairs >= maxReviewRepairs) throw new Error(`Architect exceeded ${maxReviewRepairs} focused acceptance refinements: ${scopeError || reviewed.value.summary}`);
        acceptanceRepairs += 1;
        onProgress?.({ phase: "refining", attempt: repairs + acceptanceRepairs, detail: reviewed.value.summary, at: new Date().toISOString() });
        const refined = await callModel(runner, "acceptance-refinement", {
          role: "architect", cwd: root, profile,
          prompt: (textFlow&&!requireTopologyChange?`Correct the wording and transition conditions of this existing flow in clear ${language}. The code retains its steps and relation IDs; return a condition for each supplied relation ID. Preserve unaffected text and facts. Set needsTopologyChange=false when the review can be resolved by correcting conditions or wording. Set it true only if fixing an incorrect path actually requires different steps or relations. Review: ${JSON.stringify(reviewed.value)}. Flow: ${JSON.stringify(textFlow)}`:fragment?`Correct only the supplied map objects to resolve the review. Preserve their IDs and all unaffected facts. Return complete objects in these arrays; do not reconstruct other parts of the map. For flows explicitly select transitionMode: append to add the missing tail after the existing final node; conditions to edit only existing conditions; replace only when you supply the ENTIRE ordered path from its beginning to its final result. Append must include every remaining connecting edge needed to reach the result, including existing relations, not just a newly added edge. Preserve the original prefix when completing an unfinished journey. The program derives steps from relation endpoints, so do not output steps or use a flow ID as a component. You may return up to six new or corrected relations needed by these transitions between EXISTING component IDs; include evidence and preserve unrelated relations. Return an empty relations array when no new edge is necessary. Keep clear ${language} wording. Review: ${JSON.stringify(reviewed.value)}. Objects: ${JSON.stringify(fragment)}. Read-only component IDs: ${JSON.stringify(baseline.entities.map(({id,label})=>({id,label})))}. Read-only connections: ${JSON.stringify(baseline.relations.map(({id,from,to,label,status})=>({id,from,to,label,status})))}. Previous error: ${scopeError}`:architectRefinementPrompt({ value: baseline, review: reviewed.value, scopeError })) + `\nCurrent sources for the reviewed fragment and reader context: ${JSON.stringify({sources:refinementSources,profile:knowledge.profile})}`, outputSchema: textFlow&&!requireTopologyChange?flowTextSchema(textFlow):fragment?refinementFragmentSchema(fragment,baseline):ARCHITECT_OUTPUT_SCHEMA,
          timeoutMs: 8 * 60_000,
          onProgress: (progress) => onProgress?.({ ...progress, phase: progress.phase === "starting" ? "refining" : progress.phase, attempt: repairs + acceptanceRepairs }),
        });
        if(textFlow&&!requireTopologyChange&&refined.value.needsTopologyChange){requireTopologyChange=true;reviewed.value={...reviewed.value,topologyChangeRequested:true};acceptanceRepairs--;saveCandidate(baseline,evidenceApproved,reviewed.value);continue;}
        const edited=textFlow&&!requireTopologyChange?{keyFlows:[mergeFlowText(textFlow,refined.value)]}:refined.value;
        try { const candidate=normalizeArchitecture(fragment?mergeRefinementFragment(baseline,edited,fragment):edited,snapshot); validateArchitecture(candidate,snapshot); assertReviewRepairScope(baseline,candidate,reviewed.value); value=candidate;pendingEvidence={...reviewed.value,sourceRequests:preciseMentioned};acceptedEvidence=[...new Map([...acceptedEvidence,...(verifiedSources?.sources||[])].map(source=>[source.reference||source.id,source])).values()]; saveCandidate(value); break; }
        catch (scopeFailure) {
          scopeError = scopeFailure.message;
          audit.append("refinement.scope-rejected", { attempt: acceptanceRepairs, error: scopeError, issues: reviewed.value.issues });
        }
      }
    }
    onProgress?.({ phase: "applying", attempt: repairs + acceptanceRepairs, at: new Date().toISOString() });
    if(verifiedSources) assertEvidenceUnchanged(root,verifiedSources);
    archiveEvidence(root,verifiedSources);
    const verification=evidenceReviewer?{state:"source-checked",at:new Date().toISOString(),code:revision,sourceHashes:(verifiedSources?.sources||[]).filter(source=>source.hash).map(({reference,hash})=>({reference,hash})),testStatus:"not-executed"}:undefined;
    const applied = applyArchitecture(value, { actor:"architect",refresh,language,knowledge:publicKnowledge(knowledge),verification,expectedSignature:baseSemanticSignature });
    const output = {
      provider: activeArchitectProfile.provider || result.provider || profile.provider || "codex", model: activeArchitectProfile.model, effort: activeArchitectProfile.effort,
      threadId: result.threadId, threadIds: [...new Set(threadIds)], reviewThreadIds: [...new Set(reviewThreadIds)],
      projectTitle: value.projectTitle, areas: value.areas.length, entities: value.entities.length, relations: value.relations.length,
      repairs, acceptanceRepairs, semanticReviews, evidenceReviews, semanticRegenerations: 0, reviewWarnings, coverage:knowledge.coverage || null,
      calls: calls.length, models:[...new Set(calls.map(call=>call.model).filter(Boolean))], usage: { ...usage }, auditRunId: audit.runId, auditFile: audit.file,
      events: applied.events, revision: applied.snapshot.revision,
    };
    if(resumeCandidate) writeSourceJson(candidateFile,{status:"applied",revision:output.revision,updatedAt:new Date().toISOString()});
    audit.append("run.completed", output);
    return output;
  } catch (error) {
    const failure = summary();
    if(!signal?.aborted&&lastVerified&&evidenceReviewer&&/предел расхода|Owner-readability review rejected/.test(error.message)) {
      try {
        assertEvidenceUnchanged(root,lastVerified.sources);validateArchitecture(lastVerified.value,snapshot);
        archiveEvidence(root,lastVerified.sources);
        const partial=applyArchitecture(lastVerified.value,{actor:"architect",refresh,language,knowledge:publicKnowledge(knowledge),verification:{state:"source-checked",readability:"needs-review",reason:"Факты подтверждены. Проверка понятности ещё не завершена.",at:new Date().toISOString(),code:revision,testStatus:"not-executed"},expectedSignature:baseSemanticSignature});
        if(resumeCandidate)writeSourceJson(candidateFile,{value:lastVerified.value,signature,sourcePolicy,auditRunId:audit.runId,baseRevision:partial.snapshot.revision,baseSemanticSignature:semanticSignature(partial.snapshot),viewpoint,language,knowledge:publicKnowledge(knowledge),preparedSources,verifiedSources:lastVerified.sources,evidenceExtraRefs:[],pendingEvidence:null,acceptedEvidence:[],evidenceApproved:true,pendingReview:pendingReview?.value||null,status:"candidate",updatedAt:new Date().toISOString()});
        const output={...failure,outcome:"partial",verified:true,canResume:true,revision:partial.snapshot.revision,events:partial.events};audit.append("run.partial",output);return output;
      } catch(partialError) {audit.append("partial.rejected",{reason:partialError.message});}
    }
    audit.append("run.failed", { ...failure, error: String(error?.message || error).slice(0, 2000) });
    error.audit = {...failure,canResume:Boolean(value&&resumeCandidate)};
    throw error;
  } finally {
    await solSession?.close?.();
  }
}
