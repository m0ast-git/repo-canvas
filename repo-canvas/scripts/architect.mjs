import { getSnapshot } from "./canvas-store.mjs";
import { projectRoot } from "./project-root.mjs";
import { runCodexStructured } from "./model-runtime.mjs";
import { ARCHITECT_OUTPUT_SCHEMA, applyArchitecture } from "./semantic-model.mjs";

function compactCurrentMap(snapshot) {
  return {
    map: snapshot.map,
    areas: snapshot.areas.map(({ id, title, note, color, evidence }) => ({ id, title, note, color, evidence })),
    entities: snapshot.entities.map(({ id, areaId, parentId, label, kind, status, purpose, path, evidence }) => ({ id, areaId, parentId, label, kind, status, purpose, path, evidence })),
    relations: snapshot.relations.map(({ id, from, to, label, kind, contract, mechanism, evidence, status }) => ({ id, from, to, label, kind, contract, mechanism, evidence, status })),
  };
}

export function architectPrompt({ snapshot, refresh, viewpoint = "" }) {
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
- all keyFlow steps must reference returned or retained entity ids;
- return the required structured output only.

Quality gates:
- a new reader can explain the responsibility of every area and entity from its name and purpose;
- every relation answers 'what does the source do to/for the target?';
- important repository outcomes can be followed through keyFlows;
- no duplicate concepts at different abstraction levels;
- no entity or relation exists solely because a similarly named folder/file exists;
- uncertain claims are omitted and listed in unresolvedQuestions.

Refresh mode: ${refresh ? "yes" : "no"}
Owner viewpoint: ${viewpoint || "No preference; choose from repository evidence."}
Current semantic map:
${current}`;
}

export async function runArchitect({
  root = projectRoot,
  refresh = false,
  viewpoint = "",
  model,
  effort,
  runner = runCodexStructured,
} = {}) {
  const snapshot = getSnapshot();
  const profile = model || effort ? {
    model: model || process.env.REPO_CANVAS_ARCHITECT_MODEL || "gpt-5.6-sol",
    effort: effort || process.env.REPO_CANVAS_ARCHITECT_EFFORT || "medium",
  } : undefined;
  const result = await runner({
    role: "architect",
    cwd: root,
    prompt: architectPrompt({ snapshot, refresh, viewpoint }),
    outputSchema: ARCHITECT_OUTPUT_SCHEMA,
    ...(profile ? { profile } : {}),
  });
  const applied = applyArchitecture(result.value, { actor: "architect", refresh });
  return {
    provider: "codex",
    model: result.profile?.model || profile?.model,
    effort: result.profile?.effort || profile?.effort,
    threadId: result.threadId,
    projectTitle: result.value.projectTitle,
    areas: result.value.areas.length,
    entities: result.value.entities.length,
    relations: result.value.relations.length,
    events: applied.events,
    revision: applied.snapshot.revision,
  };
}
