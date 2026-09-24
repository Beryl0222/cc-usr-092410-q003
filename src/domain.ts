/** 新兴赛项裁判证据台使用的领域事件信封。 */
export type AggregateType =
  | "competition_rule"
  | "contest_round"
  | "score_evidence"
  | "appeal_case"
  | "score_result"
  | "ranking_publication";

export type EventType =
  | "RULE_ACTIVATED"
  | "ROUND_STARTED"
  | "EVIDENCE_RECORDED"
  | "RULING_AMENDED"
  | "RESULT_CERTIFIED"
  | "APPEAL_ACCEPTED"
  | "APPEAL_EVIDENCE_APPENDED"
  | "EVIDENCE_WINDOW_CLOSED"
  | "RULE_DOUBT_RAISED"
  | "REVIEWER_ASSIGNED"
  | "RULING_DRAFTED"
  | "RULING_SIGNED"
  | "RULING_ISSUED"
  | "SCORE_RECOMPUTED"
  | "ROUND_ANNULLED"
  | "RANKING_PUBLISHED"
  | "RETRIAL_SUGGESTED"
  | "SUBMISSION_QUARANTINED"
  | "QUARANTINE_RESOLVED";

export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: unknown;
}

/** 裁决结果：维持、局部重算或撤销某个赛段。 */
export type RulingOutcome = "UPHOLD" | "PARTIAL_RECOMPUTE" | "ANNUL_ROUND";

/** 申诉案件状态：复核中或已裁决。 */
export type AppealStatus = "under_review" | "ruled";
