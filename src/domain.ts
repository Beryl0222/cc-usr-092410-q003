/** 新兴赛项裁判证据台使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
}
