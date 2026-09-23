const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  return errors;
}
