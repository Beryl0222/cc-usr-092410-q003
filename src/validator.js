const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/** 与 contracts/domain.schema.json 中枚举保持一致，由契约测试校验。 */
export const EVENT_TYPES = [
  "RULE_ACTIVATED",
  "ROUND_STARTED",
  "EVIDENCE_RECORDED",
  "RULING_AMENDED",
  "RESULT_CERTIFIED",
  "REVIEWER_REGISTERED",
  "APPEAL_ACCEPTED",
  "APPEAL_QUARANTINED",
  "EVIDENCE_ATTACHED",
  "EVIDENCE_QUARANTINED",
  "DOUBT_RAISED",
  "RECUSAL_SCREENED",
  "REVIEWER_ASSIGNED",
  "RULING_SIGNED",
  "RULING_ISSUED",
  "SCORE_CORRECTED",
  "RETRIAL_SUGGESTED",
  "RETRIAL_OPENED",
  "RANKING_PUBLISHED",
  "APPEAL_WINDOW_CLOSED",
];

export const AGGREGATE_TYPES = [
  "competition_rule",
  "contest_round",
  "score_evidence",
  "appeal_case",
  "reviewer",
  "ranking_publication",
];

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  return errors;
}
