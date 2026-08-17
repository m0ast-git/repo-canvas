import fs from "node:fs";
import path from "node:path";

import { getSnapshot } from "./canvas-store.mjs";
import { projectRoot } from "./project-root.mjs";
import { runCodexStructured } from "./model-runtime.mjs";
import { ARCHITECT_OUTPUT_SCHEMA, applyArchitecture, validateArchitecture } from "./semantic-model.mjs";

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

This is a one-time read-only architecture pass. Use medium-depth analysis. Do not modify files and do not call Repo Canvas commands.

Your job is to explain how this particular project is organized and how its meaningful parts collaborate. Choose the viewpoint that best fits the evidence: a flow, hierarchy, core with extensions, domain/context landscape, clustered system, or a justified hybrid. Do not force every repository into a left-to-right pipeline. The owner may supply a preferred viewpoint below; follow it when it is compatible with repository evidence.

Work in this order before producing output:
1. Establish the project's purpose, users/consumers, entry points and externally visible outcomes from primary repository evidence.
2. Identify responsibility boundaries using DDD context-map principles: each area has a coherent responsibility and vocabulary; in non-business projects a context may be a subsystem, execution boundary, pipeline stage family, platform surface or infrastructure responsibility.
3. Admit a map entity only when you can state its responsibility and cite durable evidence such as an entry point, public contract, runtime process, schema/store, integration, documented capability or independent pipeline stage.
4. Build a parent hierarchy only when the repository proves that a block contains meaningful subcomponents. Empty parentId means a top-level entity in its area.
5. Trace the important end-to-end scenarios from trigger to outcome. Use them to test coverage and relation direction; keyFlows are validation scenarios, not extra canvas entities.
6. Derive relations from actual runtime, data, control, event, contract or necessary dependency evidence.
7. Review the draft against the quality gates below and remove speculative or implementation-noise elements.

Language contract:
- every human-visible area title/note, entity label/purpose/note, relation label, key-flow title/trigger/outcome and unresolved question uses one consistent language;
- a non-empty owner viewpoint is the strongest language signal; otherwise use the language of user-facing product text and primary project documentation;
- code identifiers, filenames, protocol names and contract names may remain technical, but do not turn them into unexplained user-visible jargon;
- write for the repository owner: prefer plain domain language over framework slang, abbreviations and architecture terminology the project itself does not explain.

Requirements:
- stable concise ASCII ids;
- short Russian labels and descriptions when repository context is Russian, otherwise use its working language;
- areas describe responsibilities, never directory buckets such as src, backend, utils, misc or tests;
- entities may be capabilities, modules, services, processes, stores, interfaces, integrations, externals or components;
- do not mirror folders, individual files, classes, helpers, tests or completed tasks;
- every entity has concrete repository evidence; use evidence paths/symbols as references, never as the entity identity;
- every relation is unidirectional and its visible label is a specific verb plus object consistent with that direction, for example 'передаёт сырой профиль' or 'публикует событие проверки';
- never use vague labels such as 'uses', 'depends on', 'interacts with', 'связан с', 'использует' or 'зависит от' without naming the actual action/object;
- contract names what crosses the boundary; mechanism names how it crosses (HTTP, queue, SQL, import, function call, file, etc.); leave either empty only when evidence genuinely does not expose it;
- evidence must support both relation endpoints and direction;
- path is optional reference evidence and never the identity of an entity;
- operational means intended to work; planned only for an approved concept that is not implemented;
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
- no entity or relation exists solely because a similarly named folder/file exists;
- uncertain claims are omitted and listed in unresolvedQuestions.

Mandatory preflight before returning JSON:
1. Build the exact set of returned and retained area ids and verify every entity.areaId against it.
2. Build the exact set of returned and retained entity ids and verify every non-empty parentId, relation from/to and every keyFlow step against it.
3. Verify parent chains are acyclic and remain inside one area.
4. Verify removed ids are not referenced anywhere in the new map.
5. Verify all human-visible text follows the language contract above.
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
  entityItem.areaId = { ...entityItem.areaId, enum: ids.areaIds };
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
- rerun the five preflight checks from the Architect contract before returning JSON.

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

export async function runArchitect({
  root = projectRoot,
  refresh = false,
  viewpoint = "",
  model,
  effort,
  runner = runCodexStructured,
  onProgress,
  maxRepairs = 2,
} = {}) {
  const snapshot = getSnapshot();
  const language = preferredMapLanguage(viewpoint, snapshot, repositoryLanguageSample(root));
  const profile = model || effort ? {
    model: model || process.env.REPO_CANVAS_ARCHITECT_MODEL || "gpt-5.6-sol",
    effort: effort || process.env.REPO_CANVAS_ARCHITECT_EFFORT || "medium",
  } : undefined;
  const result = await runner({
    role: "architect",
    cwd: root,
    prompt: architectPrompt({ snapshot, refresh, viewpoint, language }),
    outputSchema: ARCHITECT_OUTPUT_SCHEMA,
    onProgress: (progress) => onProgress?.({ ...progress, attempt: 0 }),
    ...(profile ? { profile } : {}),
  });
  let value = result.value;
  let repairs = 0;
  let pendingError = null;
  const threadIds = [result.threadId].filter(Boolean);
  while (true) {
    let error = pendingError; pendingError = null;
    if (!error) {
      try {
        onProgress?.({ phase: "validating", attempt: repairs, at: new Date().toISOString() });
        validateArchitecture(value, snapshot);
        validateArchitectureLanguage(value, language);
        break;
      } catch (caught) { error = caught; }
    }
    if (repairs >= maxRepairs) throw new Error(`Architect could not produce a valid map after ${repairs} repair attempts: ${error.message}`);
    repairs += 1;
    onProgress?.({ phase: "repairing", attempt: repairs, detail: error.message, at: new Date().toISOString() });
    const repaired = await runner({
      role: "architect",
      cwd: root,
      prompt: architectRepairPrompt({ value, snapshot, error, language }),
      outputSchema: architectureRepairSchema(value, snapshot),
      timeoutMs: 8 * 60_000,
      profile: result.profile || profile,
      onProgress: (progress) => onProgress?.({ ...progress, phase: progress.phase === "starting" ? "repairing" : progress.phase, attempt: repairs }),
    });
    try { assertRepairScope(value, repaired.value); value = repaired.value; }
    catch (scopeError) { pendingError = scopeError; }
    if (repaired.threadId) threadIds.push(repaired.threadId);
  }
  onProgress?.({ phase: "applying", attempt: repairs, at: new Date().toISOString() });
  const applied = applyArchitecture(value, { actor: "architect", refresh });
  return {
    provider: "codex",
    model: result.profile?.model || profile?.model,
    effort: result.profile?.effort || profile?.effort,
    threadId: result.threadId,
    threadIds,
    projectTitle: value.projectTitle,
    areas: value.areas.length,
    entities: value.entities.length,
    relations: value.relations.length,
    repairs,
    events: applied.events,
    revision: applied.snapshot.revision,
  };
}
