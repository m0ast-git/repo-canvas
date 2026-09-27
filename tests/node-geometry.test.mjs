import test from "node:test";
import assert from "node:assert/strict";

import {
  ENTITY_MAX_WIDTH, ENTITY_MIN_WIDTH, entityCardSize, groupHeaderSize, wrappedLineCount,
} from "../client/src/node-geometry.js";

test("entity cards keep a common width and bounded title space", () => {
  const short = entityCardSize({ label: "API" });
  const normal = entityCardSize({ label: "Производственный модуль 2.1" });
  const long = entityCardSize({ label: "Длинное название производственного модуля для обработки нормализованной спецификации" });
  assert.equal(short.width, ENTITY_MIN_WIDTH);
  assert.equal(normal.width, short.width, "cards share a column width instead of widening into neighbours");
  assert.equal(long.width, ENTITY_MAX_WIDTH);
  assert.ok(long.titleLines > 1);
  assert.ok(long.height >= normal.height);
  assert.ok(long.titleLines <= 3);
});

test("long descriptions use a bounded preview while full content remains in the inspector",()=>{
  const short=entityCardSize({label:"Проверка",purpose:"Проверяет данные"});
  const long=entityCardSize({label:"Проверка",purpose:"Собирает сведения из нескольких источников, проверяет согласованность полученных данных и передаёт подготовленный результат следующему участнику процесса."});
  assert.equal(short.width,long.width);
  assert.ok(long.purposeLines>short.purposeLines);
  assert.equal(long.purposeLines,2);
  assert.ok(long.height<=short.height+36);
});

test("deterministic wrapping handles long unbroken identifiers and group headers", () => {
  assert.ok(wrappedLineCount("VeryLongUnbrokenRepositoryIdentifierWithoutSpaces", 90, 15) > 1);
  const header = groupHeaderSize({ label: "Подсистема проверки и нормализации входящих спецификаций", purpose: "Проверяет и передаёт результат" }, 320);
  assert.ok(header.titleLines > 1);
  assert.ok(header.height > 76);
});
