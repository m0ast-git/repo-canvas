import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getSnapshot } from "./canvas-store.mjs";
import { projectRoot, resolveDataDirectory } from "./project-root.mjs";
import { MODEL_PROFILES, createCodexStructuredSession, runCodexStructured } from "./model-runtime.mjs";
import { ARCHITECT_OUTPUT_SCHEMA, ARCHITECT_REVIEW_SCHEMA, applyArchitecture, validateArchitecture } from "./semantic-model.mjs";

function compactCurrentMap(snapshot) {
  return {
    map: snapshot.map,
    areas: snapshot.areas.map(({ id, title, note, color, evidence, ownerTitle, ownerNote }) => ({ id, title, note, color, evidence, ownerTitle, ownerNote })),
    entities: snapshot.entities.map(({ id, areaId, parentId, label, kind, status, purpose, path, evidence, ownerLabel, ownerPurpose }) => ({ id, areaId, parentId, label, kind, status, purpose, path, evidence, ownerLabel, ownerPurpose })),
    relations: snapshot.relations.map(({ id, from, to, label, kind, contract, mechanism, evidence, status, ownerLabel }) => ({ id, from, to, label, kind, contract, mechanism, evidence, status, ownerLabel })),
  };
}

export function architectPrompt({ snapshot, refresh, viewpoint = "", language = null }) {
  const current = refresh ? JSON.stringify(compactCurrentMap(snapshot)) : "No prior semantic map exists.";
  return `You are Repo Canvas Architect. Build an evidence-backed, human-readable project map of the repository in your current working directory.

This is the first turn of one persistent read-only Architect session. Use medium-depth analysis. Inspect the repository once now; after you return the candidate, an independent reviewer may send focused follow-up feedback into this same session. Reuse the evidence and context already collected for those follow-ups instead of rereading the repository. Do not modify files and do not call Repo Canvas commands.

Your job is to give the repository owner a reliable mental model of the project: what it does, which responsibility-bearing parts it owns, what state those parts are in and how they collaborate. Those same parts must be useful targets for live agent work. Choose the composition that best fits the evidence: a flow, hierarchy, core with extensions, domain/context landscape, clustered system or justified hybrid. A key flow tests coverage; it never dictates the canvas shape. The owner may supply a preferred viewpoint below; follow it when it is compatible with repository evidence.

Work in this order before producing output:
1. Inventory repository truth before extracting concepts: identify active/canonical documentation, executable current reality, explicitly historical material and approved-but-unimplemented plans. Respect precedence declarations made by the repository itself. Do not average active and stale sources together.
2. Write projectSummary as the map thesis in two to four plain sentences: what the project does, who uses or operates it when people exist, what enters, what useful result leaves and which major promises are still only planned.
3. Identify responsibility boundaries using DDD context-map principles. Each area owns one coherent responsibility and vocabulary; in non-business projects it may be a subsystem, execution boundary, stage family, platform surface or infrastructure responsibility.
4. Admit a normal map entity only when all three are true: it has one named responsibility, durable repository evidence, and it is a meaningful target for implementation or understanding work. A capability is allowed only when it has its own evidenced responsibility; an end-to-end narrative that merely repeats a keyFlow is not an entity.
5. When the product genuinely involves a human user, operator, reviewer or other participant, represent that person with kind=person as outside context: areaId="", parentId="", path="". Use the concrete domain role from primary evidence. Its purpose describes only what that person inputs, does, decides, expects or receives; never assign the system's whole workflow to a person. Every person must have at least one explanatory relation to a project entity.
6. Keep non-human external systems as kind=external. Input files, output files and abstract outcomes belong in relation contracts or keyFlow trigger/outcome text unless the repository manages them as an actual store or contract.
7. Build a parent hierarchy only when a parent owns a broader responsibility and its children are independently useful work targets. Service, store, interface and integration may be peers when they share the same responsibility depth. Never duplicate one concept as both a broad narrative node and its implementation boundary.
8. Trace important end-to-end scenarios from trigger to outcome. keyFlows validate coverage and direction through real project entities; people and conceptual actions stay in trigger/outcome text and are not keyFlow steps.
9. Derive relations from actual runtime, data, control, event, contract or necessary dependency evidence, then review the draft against the quality gates below.

Language contract:
- every human-visible area title/note, entity label/purpose/note, relation label, key-flow title/trigger/outcome and unresolved question uses one consistent language;
- a non-empty owner viewpoint is the strongest language signal; otherwise use the language of user-facing product text and primary project documentation;
- code identifiers, filenames, protocol names and contract names may remain technical, but do not turn them into unexplained user-visible jargon;
- write for the repository owner: prefer plain domain language over framework slang, abbreviations and architecture terminology the project itself does not explain.

Requirements:
- stable concise ASCII ids;
- short Russian labels and descriptions when repository context is Russian, otherwise use its working language;
- every area title answers 'what responsibility lives here?' in concrete owner language; avoid abstract buckets such as 'user product', 'runtime', src, backend, utils, misc or tests;
- normal entities may be capabilities, modules, services, processes, stores, interfaces, integrations, externals or components; human participants use kind=person and stay outside all areas;
- do not mirror folders, individual files, classes, helpers, tests or completed tasks;
- every entity has concrete repository evidence; use evidence paths/symbols as references, never as the entity identity;
- every relation is unidirectional and its visible label is a specific verb plus object consistent with that direction, for example 'передаёт сырой профиль' or 'публикует событие проверки';
- never use vague labels such as 'uses', 'depends on', 'interacts with', 'связан с', 'использует' or 'зависит от' without naming the actual action/object;
- contract names what crosses the boundary; mechanism names how it crosses (HTTP, queue, SQL, import, function call, file, etc.); leave either empty only when evidence genuinely does not expose it;
- evidence must support both relation endpoints and direction;
- path is optional reference evidence and never the identity of an entity;
- operational means current executable or otherwise working project reality; disabled is retained history that still matters; planned is an approved concept that is not implemented. Do not make planned relations float between only operational entities;
- report removals only when refreshing and the concept genuinely no longer exists;
- a renamed, moved or reimplemented concept keeps its stable entity id;
- choose a warm distinct hex identity color for every area; keep existing owner colors on refresh unless the area is new;
- layoutIntent describes the project's useful composition, not a visual decoration; layoutDirection may be AUTO when no axis is semantically dominant;
- there is no count limit: include every evidenced element required to understand the project, whether that is 4 or 400, but stop before implementation noise;
- unresolvedQuestions contains important ambiguities that evidence cannot resolve; do not turn those ambiguities into entities or relations;
- every parentId, relation endpoint and keyFlow step is an exact id from the returned or retained entity set;
- keyFlow steps contain entity ids only; conceptual actions that are not map entities belong in trigger/outcome text and must never be invented as step ids;
- return the required structured output only.

Quality gates:
- a new reader can explain the responsibility of every area and entity from its name and purpose;
- every relation answers 'what does the source do to/for the target?';
- important repository outcomes can be followed through keyFlows;
- no duplicate concepts at different abstraction levels;
- every normal entity is a credible work target; people are context participants and never work targets;
- every person's name is a concrete evidenced role and its purpose describes only that person's side of the interaction;
- projectSummary lets a reader explain the project before opening any card;
- no entity or relation exists solely because a similarly named folder/file exists;
- uncertain claims are omitted and listed in unresolvedQuestions.

Mandatory preflight before returning JSON:
1. Build the exact set of returned and retained area ids and verify every normal entity.areaId against it; every person has empty areaId, parentId and path.
2. Build the exact set of returned and retained entity ids and verify every non-empty parentId, relation from/to and every keyFlow step against it.
3. Verify parent chains are acyclic and remain inside one area.
4. Verify removed ids are not referenced anywhere in the new map.
5. Verify every person participates in a relation and every planned relation touches a planned entity.
6. Verify all human-visible text follows the language contract above.
If any check fails, correct the JSON before returning it. Never return a knowingly invalid draft.

Refresh mode: ${refresh ? "yes" : "no"}
Owner viewpoint: ${viewpoint || "No preference; choose from repository evidence."}
Target visible language: ${language || "Infer one consistent owner language from user-facing repository evidence."}
Current semantic map:
${current}`;
}

function sameIds(before, after, field) {
  const left = [...new Set((before || []).map((item) => typeof item === "string" ? item : item[field]))].sort();
  const right = [...new Set((after || []).map((item) => typeof item === "string" ? item : item[field]))].sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function preferredMapLanguage(viewpoint = "", snapshot = { map: {}, areas: [], entities: [], relations: [] }, repositoryText = "") {
  const explicit = String(viewpoint || "").trim();
  if ((explicit.match(/[А-Яа-яЁё]/g) || []).length >= 2) return "ru";
  if (!/[А-Яа-яЁё]/.test(explicit) && (explicit.match(/[A-Za-z]/g) || []).length >= 4) return "en";
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

export function architectureLanguageIssues(value, language) {
  if (!language) return [];
  const issues = [];
  for (const [field, text] of visibleFields(value)) {
    if (language === "ru") {
      const singleTechnicalName = /^[A-Za-z][A-Za-z0-9+.#/-]{1,30}$/.test(text.trim());
      if (!/[А-Яа-яЁё]/.test(text) && !singleTechnicalName) issues.push(`${field} must use Russian owner-facing language`);
      const generic = [...text.matchAll(UNTRANSLATED_RUSSIAN_GENERIC)].map((match) => match[0].toLowerCase());
      if (generic.length) issues.push(`${field} contains untranslated generic terms: ${[...new Set(generic)].join(", ")}`);
    }
    if (language === "en" && /[А-Яа-яЁё]/.test(text)) issues.push(`${field} must use English owner-facing language`);
  }
  return issues;
}

export function validateArchitectureLanguage(value, language) {
  const issues = architectureLanguageIssues(value, language);
  if (issues.length) throw new Error(`Visible language '${language}' failed: ${issues.slice(0, 16).join("; ")}`);
  return value;
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
    if (!looksLikeLocalReference(String(reference || ""))) return;
    const candidates = localReferenceCandidates(reference);
    if (candidates.length && !candidates.some((candidate) => fs.existsSync(path.resolve(root, candidate)))) issues.push(`${scope}.${id} references missing evidence '${reference}'`);
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

export function architectReviewPrompt(value, language) {
  return `You are the independent owner-readability reviewer for Repo Canvas. You receive only the proposed map, with no repository access or hidden implementation context. Judge whether an intelligent project owner can understand the system from the map alone.

Use ${language === "ru" ? "Russian" : language === "en" ? "English" : "the map's own language"}. Do not inspect files or run tools. Do not reward plausible jargon.

Pass only when all critical conditions hold:
- projectSummary plainly says what the project does, for whom when relevant, what enters and what useful result leaves;
- every area title and note identify one concrete responsibility and distinguish it from sibling areas;
- every normal entity names one project-owned responsibility and is a credible target for work, not a person, file, abstract outcome or whole end-to-end story;
- every person is a concrete human role, sits outside areas, has a narrow purpose describing only its actions/inputs/decisions/expectations, and is connected by an explanatory relation;
- no concept is duplicated as both a broad narrative node and its implementation boundary;
- relation labels explain directed actions and keyFlows make important work traceable without forcing the map into a pipeline;
- operational, disabled and planned concepts are understandable and not blended deceptively.

Answer the three comprehension questions yourself, then report specific issues. For every issue, scope must name the object type and id must be the exact existing map id of that area, entity, relation or flow; use id="map" only for a project-wide thesis problem. Set passed=false whenever at least one critical issue exists. Return structured output only.

Proposed map:
${JSON.stringify(compactReviewMap(value))}`;
}

export function architectRefinementPrompt({ value, review, scopeError = "" }) {
  return `Continue the same Repo Canvas Architect session. An independent Luna reviewer has inspected your candidate without repository access.

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
  const unique = (values) => [...new Set(values)];
  const areaItem = schema.properties.areas.items.properties;
  const entityItem = schema.properties.entities.items.properties;
  const relationItem = schema.properties.relations.items.properties;
  areaItem.id = { ...areaItem.id, enum: unique(value.areas.map((item) => item.id)) };
  entityItem.id = { ...entityItem.id, enum: unique(value.entities.map((item) => item.id)) };
  entityItem.areaId = { ...entityItem.areaId, enum: ["", ...ids.areaIds] };
  entityItem.parentId = { ...entityItem.parentId, enum: ["", ...ids.entityIds] };
  relationItem.id = { ...relationItem.id, enum: unique(value.relations.map((item) => item.id)) };
  relationItem.from = { ...relationItem.from, enum: ids.entityIds };
  relationItem.to = { ...relationItem.to, enum: ids.entityIds };
  const steps = schema.properties.keyFlows.items.properties.steps;
  steps.items = { ...steps.items, enum: ids.entityIds };
  schema.properties.removedAreaIds.items = { ...schema.properties.removedAreaIds.items, enum: snapshot.areas.map((item) => item.id) };
  schema.properties.removedEntityIds.items = { ...schema.properties.removedEntityIds.items, enum: snapshot.entities.map((item) => item.id) };
  schema.properties.removedRelationIds.items = { ...schema.properties.removedRelationIds.items, enum: snapshot.relations.map((item) => item.id) };
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
  model,
  effort,
  runner = runCodexStructured,
  reviewer = runCodexStructured,
  onProgress,
  maxRepairs = 3,
  maxReviewRepairs = 3,
  sessionFactory = null,
} = {}) {
  const audit = createArchitectAudit(root);
  const snapshot = getSnapshot();
  const language = preferredMapLanguage(viewpoint, snapshot, repositoryLanguageSample(root));
  const profile = {
    model: model || MODEL_PROFILES.architect.model,
    effort: effort || MODEL_PROFILES.architect.effort,
  };
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const calls = [];
  let solSession = null;
  let result = null;
  let value = null;
  let repairs = 0;
  let acceptanceRepairs = 0;
  let semanticReviews = 0;
  let reviewWarnings = 0;
  const threadIds = [];
  const reviewThreadIds = [];
  const summary = () => ({ runId: audit.runId, auditFile: audit.file, calls: calls.length, usage: { ...usage }, repairs, acceptanceRepairs, semanticReviews });
  const callModel = async (callRunner, phase, options) => {
    const index = calls.length + 1; const startedAt = new Date().toISOString(); const started = Date.now();
    try {
      const response = await callRunner(options);
      const callUsage = normalizeUsage(response.usage);
      addUsage(usage, callUsage);
      const record = {
        index, phase, role: options.role, model: response.profile?.model || options.profile?.model || MODEL_PROFILES[options.role]?.model,
        effort: response.profile?.effort || options.profile?.effort || MODEL_PROFILES[options.role]?.effort,
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
      : runner === runCodexStructured
        ? await createCodexStructuredSession({ cwd: root, profile })
        : { cwd: root, profile, threadId: null, turns: 0, closed: false, close: async () => {} };
    result = await callModel(runner, "initial", {
      role: "architect", cwd: root, session: solSession, profile,
      prompt: architectPrompt({ snapshot, refresh, viewpoint, language }), outputSchema: ARCHITECT_OUTPUT_SCHEMA,
      onProgress: (progress) => onProgress?.({ ...progress, attempt: 0 }),
    });
    value = result.value;
    if (result.threadId) threadIds.push(result.threadId);

    while (true) {
      let pendingError = null;
      while (true) {
        let validationError = pendingError; pendingError = null;
        if (!validationError) {
          try {
            onProgress?.({ phase: "validating", attempt: repairs + acceptanceRepairs, at: new Date().toISOString() });
            validateArchitecture(value, snapshot);
            validateArchitectureLanguage(value, language);
            validateArchitectureEvidence(value, root);
            break;
          } catch (caught) { validationError = caught; }
        }
        audit.append("validation.rejected", { attempt: repairs + 1, error: validationError.message });
        if (repairs >= maxRepairs) throw new Error(`Architect could not produce a valid map after ${repairs} focused structural repairs: ${validationError.message}`);
        repairs += 1;
        onProgress?.({ phase: "repairing", attempt: repairs + acceptanceRepairs, detail: validationError.message, at: new Date().toISOString() });
        const repaired = await callModel(runner, "structural-repair", {
          role: "architect", cwd: root, session: solSession,
          prompt: architectRepairPrompt({ value, snapshot, error: validationError, language }),
          outputSchema: architectureRepairSchema(value, snapshot), timeoutMs: 8 * 60_000, profile,
          onProgress: (progress) => onProgress?.({ ...progress, phase: progress.phase === "starting" ? "repairing" : progress.phase, attempt: repairs + acceptanceRepairs }),
        });
        try { assertRepairScope(value, repaired.value); value = repaired.value; }
        catch (scopeError) { pendingError = scopeError; }
      }

      const reviewDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "repo-canvas-review-"));
      let reviewed;
      try {
        onProgress?.({ phase: "reviewing", attempt: repairs + acceptanceRepairs, at: new Date().toISOString() });
        reviewed = await callModel(reviewer, "owner-review", {
          role: "reviewer", cwd: reviewDirectory,
          prompt: architectReviewPrompt(value, language), outputSchema: architectureReviewSchema(value), timeoutMs: 3 * 60_000,
          onProgress: (progress) => onProgress?.({ ...progress, phase: "reviewing", attempt: repairs + acceptanceRepairs }),
        });
      } finally { fs.rmSync(reviewDirectory, { recursive: true, force: true }); }
      semanticReviews += 1;
      validateReviewerDecision(value, reviewed.value);
      if (reviewed.threadId) reviewThreadIds.push(reviewed.threadId);
      const critical = (reviewed.value.issues || []).filter((issue) => issue.severity === "critical");
      reviewWarnings = (reviewed.value.issues || []).filter((issue) => issue.severity === "warning").length;
      audit.append("review.completed", { review: semanticReviews, passed: reviewed.value.passed, summary: reviewed.value.summary, answers: reviewed.value.answers, issues: reviewed.value.issues });
      if (reviewed.value.passed && !critical.length) break;
      if (acceptanceRepairs >= maxReviewRepairs) {
        const detail = critical.map((issue) => `${issue.scope}.${issue.id}: ${issue.message}`).join("; ") || reviewed.value.summary;
        throw new Error(`Owner-readability review rejected the map after ${semanticReviews} review(s) and ${acceptanceRepairs} focused refinements: ${detail}`);
      }

      const baseline = value; let scopeError = "";
      while (true) {
        if (acceptanceRepairs >= maxReviewRepairs) throw new Error(`Architect exceeded ${maxReviewRepairs} focused acceptance refinements: ${scopeError || reviewed.value.summary}`);
        acceptanceRepairs += 1;
        onProgress?.({ phase: "refining", attempt: repairs + acceptanceRepairs, detail: reviewed.value.summary, at: new Date().toISOString() });
        const refined = await callModel(runner, "acceptance-refinement", {
          role: "architect", cwd: root, session: solSession, profile,
          prompt: architectRefinementPrompt({ value: baseline, review: reviewed.value, scopeError }), outputSchema: ARCHITECT_OUTPUT_SCHEMA,
          timeoutMs: 8 * 60_000,
          onProgress: (progress) => onProgress?.({ ...progress, phase: progress.phase === "starting" ? "refining" : progress.phase, attempt: repairs + acceptanceRepairs }),
        });
        try { assertReviewRepairScope(baseline, refined.value, reviewed.value); value = refined.value; break; }
        catch (scopeFailure) {
          scopeError = scopeFailure.message;
          audit.append("refinement.scope-rejected", { attempt: acceptanceRepairs, error: scopeError, issues: reviewed.value.issues });
        }
      }
    }
    onProgress?.({ phase: "applying", attempt: repairs + acceptanceRepairs, at: new Date().toISOString() });
    const applied = applyArchitecture(value, { actor: "architect", refresh });
    const output = {
      provider: "codex", model: result.profile?.model || profile.model, effort: result.profile?.effort || profile.effort,
      threadId: result.threadId, threadIds: [...new Set(threadIds)], reviewThreadIds: [...new Set(reviewThreadIds)],
      projectTitle: value.projectTitle, areas: value.areas.length, entities: value.entities.length, relations: value.relations.length,
      repairs, acceptanceRepairs, semanticReviews, semanticRegenerations: 0, reviewWarnings,
      calls: calls.length, usage: { ...usage }, auditRunId: audit.runId, auditFile: audit.file,
      events: applied.events, revision: applied.snapshot.revision,
    };
    audit.append("run.completed", output);
    return output;
  } catch (error) {
    const failure = summary();
    audit.append("run.failed", { ...failure, error: String(error?.message || error).slice(0, 2000) });
    error.audit = failure;
    throw error;
  } finally {
    await solSession?.close?.();
  }
}
