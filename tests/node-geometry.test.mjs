import test from "node:test";
import assert from "node:assert/strict";

import {
  ENTITY_MAX_WIDTH, ENTITY_MIN_WIDTH, entityCardSize, groupHeaderSize, wrappedLineCount,
} from "../client/src/node-geometry.js";

test("entity cards widen and then grow so full titles never require ellipsis", () => {
  const short = entityCardSize({ label: "API" });
  const normal = entityCardSize({ label: "Производственный модуль 2.1" });
  const long = entityCardSize({ label: "Длинное название производственного модуля для обработки нормализованной спецификации" });
  assert.equal(short.width, ENTITY_MIN_WIDTH);
  assert.ok(normal.width > short.width, "a normal owner-facing title should receive enough horizontal room");
  assert.equal(long.width, ENTITY_MAX_WIDTH);
  assert.ok(long.titleLines > 1);
  assert.ok(long.height > normal.height);
});

test("deterministic wrapping handles long unbroken identifiers and group headers", () => {
  assert.ok(wrappedLineCount("VeryLongUnbrokenRepositoryIdentifierWithoutSpaces", 90, 15) > 1);
  const header = groupHeaderSize({ label: "Подсистема проверки и нормализации входящих спецификаций", purpose: "Проверяет и передаёт результат" }, 320);
  assert.ok(header.titleLines > 1);
  assert.ok(header.height > 76);
});
