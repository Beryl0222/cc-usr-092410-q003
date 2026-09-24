import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AGGREGATE_TYPES, EVENT_TYPES, validateEvent } from "../src/validator.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("校验器枚举与契约保持一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...EVENT_TYPES].sort(), [...schema.properties.event_type.enum].sort());
  assert.deepEqual([...AGGREGATE_TYPES].sort(), [...schema.properties.aggregate_type.enum].sort());
});

test("未知事件类型与聚合类型被拒绝", () => {
  const bad = {
    event_id: "x-1",
    event_type: "SOMETHING_ELSE",
    aggregate_type: "unknown",
    aggregate_id: "a-1",
    occurred_at: "2026-09-24T00:00:00.000Z",
    version: 1,
    summary: "不在约定内的事件",
  };
  const errors = validateEvent(bad);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((msg) => msg.includes("未知事件类型")));
  assert.ok(errors.some((msg) => msg.includes("未知聚合类型")));
});
