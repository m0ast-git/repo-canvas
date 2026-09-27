import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "output/playwright/stage-acceptance");
const count = Number(process.argv[3] || 30);
if (fs.existsSync(root)) throw new Error(`Fixture already exists: ${root}`);
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "package.json"), '{"name":"canvas-acceptance","private":true}\n');
process.env.REPO_CANVAS_ROOT = root;
process.env.REPO_CANVAS_DATA_DIR = path.join(root, ".repo-canvas");
const { appendEvents, createEvent } = await import("../repo-canvas/scripts/canvas-store.mjs");
const events = [];
const add = (type, payload) => events.push(createEvent(type, { actor: "acceptance-fixture", payload }));
add("map.upsert", { projectTitle: "От заявки до результата", projectSummary: "Клиент оставляет заявку. Команда проверяет данные, выполняет работу и передаёт результат.", layoutDirection: "RIGHT", keyFlows: ["Приём и выполнение заявки"], language: "ru" });
const perArea = 10;
for (let area = 0; area < Math.ceil(count / perArea); area++) {
  add("area.upsert", { id: `area-${area}`, title: ["Приём заявок", "Обработка", "Выдача результата"][area % 3] + (area > 2 ? ` ${area + 1}` : ""), note: "Здесь выполняется часть пути заявки", order: area, x: (area % 3) * 1700, y: Math.floor(area / 3) * 1500, width: 1600, height: 1400 });
}
for (let i = 0; i < count; i++) {
  const area = Math.floor(i / perArea); const local = i % perArea;
  add("entity.upsert", { id: `module-${i}`, areaId: `area-${area}`, label: `Шаг заявки ${i + 1}`, kind: "process", status: "operational", purpose: "Проверяет данные и передаёт заявку следующему участнику", inputs: ["Заявка"], outputs: ["Проверенная заявка"], x: (area % 3) * 1700 + 60 + local % 3 * 480, y: Math.floor(area / 3) * 1500 + 240 + Math.floor(local / 3) * 280 });
}
for (let i = 0; i < count * 2; i++) add("relation.upsert", { id: `route-${i}`, from: `module-${i % count}`, to: `module-${(i + 1 + Math.floor(i / count)) % count}`, label: "передаёт заявку", status: "existing", kind: "data", note: "Следующий этап обработки" });
appendEvents(events);
console.log(JSON.stringify({ root, nodes: count, relations: count * 2 }));
