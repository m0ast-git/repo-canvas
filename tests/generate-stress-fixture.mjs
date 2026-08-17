import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repositoryRoot, "repo-canvas", "scripts", "canvas.mjs");
if (process.argv[2] === "--clean") {
  const targets = process.argv.slice(3).map((item) => path.resolve(item));
  const playwrightArtifacts = path.join(repositoryRoot, ".playwright-cli");
  const stressParent = path.join(repositoryRoot, "output", "playwright");
  for (const target of targets) {
    const allowed = target === playwrightArtifacts
      || (path.dirname(target) === stressParent && path.basename(target).startsWith("stress-"));
    const qaArtifact = path.dirname(target) === stressParent && path.basename(target).startsWith("repo-canvas-");
    if (!allowed && !qaArtifact) throw new Error(`Refusing cleanup outside Repo Canvas QA paths: ${target}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ removed: targets }, null, 2));
  process.exit(0);
}
const root = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node tests/generate-stress-fixture.mjs <empty-directory>");
if (fs.existsSync(root)) throw new Error(`Stress fixture already exists: ${root}`);

fs.mkdirSync(path.join(root, ".git"), { recursive: true });
fs.writeFileSync(path.join(root, "package.json"), '{"name":"repo-canvas-stress","version":"1.0.0","private":true}\n');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${args.join(" ")} failed (${code}): ${error}`)));
  });
}

async function pool(commands, concurrency = 12) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, commands.length) }, async () => {
    while (cursor < commands.length) {
      const index = cursor;
      cursor += 1;
      await run(commands[index]);
    }
  });
  await Promise.all(workers);
}

const areaCount = 12;
const entitiesPerArea = 20;
const colors = ["#ef9a72", "#d3a24e", "#73bca4", "#70a9c1", "#9a8bd1", "#df82a5", "#b68b63", "#8eaf63", "#d78068", "#6cb4ae", "#b585b1", "#7899c5"];

await run([
  "map", "--title", "Стресс-карта промышленной платформы",
  "--summary", "Проверка семантического зума, иерархии и маршрутов без искусственных лимитов",
  "--layout", "hybrid", "--direction", "RIGHT",
  "--flows", "приём заказа,исполнение,контроль качества,обратная связь",
  "--actor", "stress-architect",
]);
await pool(Array.from({ length: areaCount }, (_, area) => [
  "area", "--id", `domain-${area + 1}`, "--title", `Промышленная область ${area + 1}`,
  "--note", "Крупная смысловая территория стресс-карты", "--color", colors[area],
  "--evidence", `src/domain-${area + 1},README.md`, "--order", String(area + 1), "--actor", "stress",
]));

const parentCommands = [];
for (let area = 0; area < areaCount; area += 1) {
  for (let index = 0; index < 4; index += 1) {
    const id = `module-${area + 1}-${index + 1}`;
    parentCommands.push([
      "entity", "--id", id, "--area", `domain-${area + 1}`,
      "--label", `Контур возможностей ${area + 1}.${index + 1}`,
      "--status", "operational", "--kind", "capability",
      "--path", `src/domain-${area + 1}/${id}`, "--purpose", "Объединяет связанные обязанности домена",
      "--evidence", `src/domain-${area + 1}/${id},docs/domain-${area + 1}.md`,
      "--actor", "stress",
    ]);
  }
}
await pool(parentCommands);

const entityCommands = [];
for (let area = 0; area < areaCount; area += 1) {
  for (let index = 4; index < entitiesPerArea; index += 1) {
    const id = `module-${area + 1}-${index + 1}`;
    entityCommands.push([
      "entity", "--id", id, "--area", `domain-${area + 1}`,
      "--parent", `module-${area + 1}-${(index % 4) + 1}`,
      "--label", `Производственный модуль ${area + 1}.${index + 1}`,
      "--status", index === 19 && area % 4 === 0 ? "planned" : "operational",
      "--kind", index % 5 === 0 ? "store" : index % 3 === 0 ? "process" : "module",
      "--path", `src/domain-${area + 1}/${id}`, "--purpose", "Исполняет подтверждённый шаг промышленного сценария",
      "--evidence", `src/domain-${area + 1}/${id}/index.ts`, "--actor", "stress",
    ]);
  }
}
await pool(entityCommands);

const people = [
  ["procurement-operator", "Оператор закупок", "Передаёт спецификацию и принимает результат проверки", "module-1-5", "передаёт спецификацию"],
  ["quality-reviewer", "Эксперт по качеству", "Принимает решение по спорным результатам", "module-4-8", "подтверждает решение"],
  ["platform-owner", "Владелец платформы", "Получает сводное состояние производственного контура", "module-7-12", "получает сводку"],
  ["support-operator", "Оператор поддержки", "Передаёт обращение и получает статус обработки", "module-9-7", "передаёт обращение"],
  ["external-auditor", "Внешний аудитор", "Запрашивает доказательства и принимает отчёт", "module-11-16", "запрашивает доказательства"],
  ["delivery-manager", "Руководитель поставки", "Получает подтверждение готовности результата", "module-12-20", "получает подтверждение"],
];
await pool(people.map(([id, label, purpose]) => [
  "entity", "--id", id, "--label", label, "--status", "operational", "--kind", "person",
  "--purpose", purpose, "--actor", "stress",
]));

const relationCommands = [];
for (let area = 0; area < areaCount; area += 1) {
  for (let index = 1; index < entitiesPerArea; index += 1) {
    relationCommands.push([
      "relation", "--from", `module-${area + 1}-${index}`, "--to", `module-${area + 1}-${index + 1}`,
      "--label", index % 3 === 0 ? "публикует событие готовности" : index % 2 === 0 ? "передаёт нормализованный поток" : "запрашивает подтверждение",
      "--kind", index % 3 === 0 ? "event" : index % 2 === 0 ? "data" : "contract",
      "--contract", "явный межмодульный контракт", "--mechanism", index % 2 === 0 ? "event bus" : "typed interface",
      "--evidence", `src/domain-${area + 1}/contracts.ts`, "--actor", "stress",
    ]);
  }
  if (area < areaCount - 1) {
    for (let index = 1; index <= entitiesPerArea; index += 4) {
      relationCommands.push([
        "relation", "--from", `module-${area + 1}-${index}`, "--to", `module-${area + 2}-${index}`,
        "--label", "согласует междоменный результат", "--kind", "contract",
        "--contract", "передача подтверждённого результата", "--mechanism", "public API",
        "--evidence", "docs/integration-contracts.md", "--actor", "stress",
      ]);
    }
  }
}
for (const [id, , , target, label] of people) {
  relationCommands.push([
    "relation", "--from", id, "--to", target, "--label", label, "--kind", "data",
    "--contract", "явный пользовательский результат", "--mechanism", "интерфейс продукта", "--actor", "stress",
  ]);
}
await pool(relationCommands);

await pool(Array.from({ length: areaCount }, (_, area) => [
  "work", "--id", `active-work-${area + 1}`, "--title", `Активная работа ${area + 1}`,
  "--targets", `module-${area + 1}-3,module-${area + 1}-4`, "--status", "active", "--actor", "stress-agent",
]));

await run(["check"]);
const snapshot = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, "snapshot"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let error = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { error += chunk; });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
});
console.log(JSON.stringify({ root, revision: snapshot.revision, ...snapshot.summary }, null, 2));
