/** 新兴赛项裁判证据台使用的领域事件信封。 */

export type AggregateType =
  | "competition_rule"
  | "contest_round"
  | "score_evidence"
  | "appeal_case"
  | "reviewer"
  | "ranking_publication";

export type EventType =
  | "RULE_ACTIVATED"
  | "ROUND_STARTED"
  | "EVIDENCE_RECORDED"
  | "RULING_AMENDED"
  | "RESULT_CERTIFIED"
  | "REVIEWER_REGISTERED"
  | "APPEAL_ACCEPTED"
  | "APPEAL_QUARANTINED"
  | "EVIDENCE_ATTACHED"
  | "EVIDENCE_QUARANTINED"
  | "DOUBT_RAISED"
  | "RECUSAL_SCREENED"
  | "REVIEWER_ASSIGNED"
  | "RULING_SIGNED"
  | "RULING_ISSUED"
  | "SCORE_CORRECTED"
  | "RETRIAL_SUGGESTED"
  | "RETRIAL_OPENED"
  | "RANKING_PUBLISHED"
  | "APPEAL_WINDOW_CLOSED";

export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  /** 同一聚合内从 1 开始连续递增的版本号。 */
  version: number;
  summary: string;
  /** 各事件类型的业务负载，详见 contracts/domain.schema.json 与 README。 */
  payload?: Record<string, unknown>;
}
