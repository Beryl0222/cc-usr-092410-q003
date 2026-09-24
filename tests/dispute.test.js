import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DisputeService } from "../src/dispute/service.js";
import { EventStore, JsonFileStore } from "../src/dispute/store.js";

const BASE = Date.parse("2026-09-24T10:00:00.000Z");
const at = (hours) => new Date(BASE + hours * 3600_000).toISOString();

function makeService(store = new EventStore()) {
  let current = at(0);
  const service = new DisputeService({ store, clock: () => current });
  return { service, store, setNow: (iso) => { current = iso; } };
}

/** 登记规则、赛段、设备消息并确认一版成绩。 */
async function seedStage(service, { round = "round-1", score = "score-1" } = {}) {
  await service.activateRule({
    rule_id: "rule-emerging",
    rule_version: 3,
    effective_from: at(-2),
    expectations: [
      { kind: "required_source", source: "device:timer", doubt: "缺少计时设备原始消息" },
      { kind: "device_seq_strict", source: "device:timer", doubt: "计时设备消息序号未严格递增" },
      { kind: "value_range", source: "device:timer", field: "measured", min: 0, max: 12, doubt: "计时测量值超出规则允许范围" },
    ],
  });
  await service.startRound({ round_id: round, rule_id: "rule-emerging", started_at: at(-1) });
  await service.recordDeviceEvidence({
    evidence_id: `${round}-msg-1`,
    round_id: round,
    device_id: "timer-1",
    vendor_id: "vendor-acme",
    source: "device:timer",
    collected_at: at(-0.5),
    details: { seq: 1, measured: 9.5 },
  });
  await service.certifyResult({
    score_id: score,
    round_id: round,
    judge_id: "judge-1",
    entries: [
      { entry_id: "e1", participant_id: "team-alpha", value: 9.5 },
      { entry_id: "e2", participant_id: "team-beta", value: 8.0 },
    ],
  });
}

test("受理申诉时冻结赛段、成绩版本、规则版本与申诉时限，规则比对只提出疑点", async () => {
  const { service } = makeService();
  await seedStage(service);

  const accepted = await service.fileAppeal({
    appeal_ref: "AP-1",
    appellant_id: "team-beta",
    score_id: "score-1",
    claims: ["计时设备消息存在缺口"],
  });
  assert.equal(accepted.deadline, at(48));

  await service.appendEvidence({
    case_id: accepted.case_id,
    source: "device:timer",
    collected_at: at(1),
    details: { seq: 3, measured: 15 },
  });
  await service.appendEvidence({
    case_id: accepted.case_id,
    source: "device:timer",
    collected_at: at(2),
    details: { seq: 2, measured: 9 },
  });

  const doubts = await service.runRuleCheck(accepted.case_id);
  assert.equal(doubts.length, 2);
  assert.ok(doubts.some((item) => item.kind === "device_seq_strict"));
  assert.ok(doubts.some((item) => item.kind === "value_range"));

  const inspected = service.inspectCase(accepted.case_id);
  assert.equal(inspected.status, "under_review", "比对只提疑点，不改变案件状态");
  assert.equal(inspected.round_id, "round-1");
  assert.equal(inspected.score_version, 1);
  assert.deepEqual(inspected.rule, { rule_id: "rule-emerging", rule_version: 3 });
  assert.equal(inspected.deadline, at(48));
});

test("重复申诉按内容识别，编号相同但材料变化时隔离待核", async () => {
  const { service, store } = makeService();
  await seedStage(service);

  const first = await service.fileAppeal({
    appeal_ref: "AP-1",
    appellant_id: "team-beta",
    score_id: "score-1",
    claims: ["原判漏看设备消息"],
  });
  const again = await service.fileAppeal({
    appeal_ref: "AP-1",
    appellant_id: "team-beta",
    score_id: "score-1",
    claims: ["原判漏看设备消息"],
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.case_id, first.case_id);

  const changed = await service.fileAppeal({
    appeal_ref: "AP-1",
    appellant_id: "team-beta",
    score_id: "score-1",
    claims: ["改口：设备供应商偏袒"],
  });
  assert.equal(changed.quarantined, true);
  assert.equal(service.quarantined().length, 1);
  assert.equal(store.events.filter((event) => event.event_type === "APPEAL_ACCEPTED").length, 1);

  const rejected = await service.resolveQuarantine(changed.submission_key, { admit: false, reason: "编号冒用" });
  assert.equal(rejected.admitted, false);
  assert.equal(service.quarantined().length, 0);

  // 离线证据回执同样按内容识别
  const receipt = await service.submitOfflineReceipt({
    receipt_id: "RC-1",
    case_id: first.case_id,
    source: "device:timer",
    collected_at: at(1),
    details: { seq: 4 },
  });
  const receiptAgain = await service.submitOfflineReceipt({
    receipt_id: "RC-1",
    case_id: first.case_id,
    source: "device:timer",
    collected_at: at(1),
    details: { seq: 4 },
  });
  assert.equal(receiptAgain.duplicate, true);
  assert.equal(receiptAgain.evidence_id, receipt.evidence_id);

  const receiptChanged = await service.submitOfflineReceipt({
    receipt_id: "RC-1",
    case_id: first.case_id,
    source: "device:timer",
    collected_at: at(1),
    details: { seq: 99 },
  });
  assert.equal(receiptChanged.quarantined, true);
  assert.equal(service.inspectCase(first.case_id).evidence.length, 1, "隔离材料不得进入案件");
});

test("复核人员回避排除，重大改判须两名不同职责签署，局部重算生成新版本而不重写旧成绩", async () => {
  const { service } = makeService();
  await seedStage(service);
  await service.registerReviewer({ reviewer_id: "rev-rules", duty: "规则复核" });
  await service.registerReviewer({
    reviewer_id: "rev-conflicted",
    duty: "技术复核",
    conflicts: { judges: ["judge-1"] },
  });
  await service.registerReviewer({ reviewer_id: "rev-tech", duty: "技术复核" });

  const { case_id: caseId } = await service.fileAppeal({
    appeal_ref: "AP-9",
    appellant_id: "team-beta",
    score_id: "score-1",
    claims: ["计时测量值越界"],
  });
  await service.appendEvidence({
    case_id: caseId,
    source: "device:timer",
    collected_at: at(1),
    details: { seq: 2, measured: 15 },
  });
  await service.runRuleCheck(caseId);

  await service.assignReviewer(caseId, "rev-rules");
  await assert.rejects(() => service.assignReviewer(caseId, "rev-conflicted"), /回避冲突/);
  await service.assignReviewer(caseId, "rev-tech");

  await service.draftRuling(caseId, {
    outcome: "PARTIAL_RECOMPUTE",
    rationale: "设备消息证实计时越界，更正对应条目",
    corrections: [{ entry_id: "e1", value: 8.5, reason: "剔除越界测量" }],
  });
  await service.signRuling(caseId, "rev-rules");
  await assert.rejects(() => service.issueRuling(caseId), /不同职责的两名/);
  await service.signRuling(caseId, "rev-tech");
  const issued = await service.issueRuling(caseId);
  assert.equal(issued.outcome, "PARTIAL_RECOMPUTE");

  const trace = service.traceScore("score-1");
  assert.equal(trace.rule.rule_version, 3);
  assert.equal(trace.device_evidence.length, 1);
  assert.equal(trace.versions.length, 2);
  assert.equal(trace.versions[0].entries.find((entry) => entry.entry_id === "e1").value, 9.5, "旧成绩保持原样");
  assert.equal(trace.versions[1].entries.find((entry) => entry.entry_id === "e1").value, 8.5);
  assert.equal(trace.versions[1].caused_by, caseId);
  assert.equal(trace.versions[1].basis_version, 1);
  assert.equal(trace.corrections.length, 1);
  assert.equal(trace.appeals[0].reviewers.length, 2);
  assert.equal(trace.appeals[0].reviewers[0].conflict_check.status, "passed");
  assert.equal(trace.appeals[0].signatures.length, 2);
});

test("并发申诉被串行受理，相同内容只立一案，并发证据不丢失", async () => {
  const { service, store } = makeService();
  await seedStage(service);

  const appealA = { appeal_ref: "AP-A", appellant_id: "team-beta", score_id: "score-1", claims: ["设备消息序号异常"] };
  const appealB = { appeal_ref: "AP-B", appellant_id: "team-alpha", score_id: "score-1", claims: ["测量值越界"] };
  const results = await Promise.all([
    service.fileAppeal(appealA),
    service.fileAppeal(appealA),
    service.fileAppeal(appealB),
  ]);
  assert.equal(results[0].case_id, results[1].case_id);
  assert.equal(results[1].duplicate, true);
  assert.notEqual(results[0].case_id, results[2].case_id);
  assert.equal(store.events.filter((event) => event.event_type === "APPEAL_ACCEPTED").length, 2);

  await Promise.all([
    service.appendEvidence({ case_id: results[0].case_id, source: "device:timer", collected_at: at(1), details: { seq: 5 } }),
    service.appendEvidence({ case_id: results[0].case_id, source: "referee:statement", collected_at: at(1.2), details: { note: "原判说明" } }),
    service.appendEvidence({ case_id: results[2].case_id, source: "device:timer", collected_at: at(1.4), details: { seq: 6 } }),
  ]);
  assert.equal(service.inspectCase(results[0].case_id).evidence.length, 2);
  assert.equal(service.inspectCase(results[2].case_id).evidence.length, 1);

  const versions = store.events
    .filter((event) => event.aggregate_type === "appeal_case")
    .map((event) => `${event.aggregate_id}#${event.version}`);
  assert.equal(new Set(versions).size, versions.length, "同一聚合的版本号不得重复");
});

test("撤销赛段后，排名发布必须引用生效裁决", async () => {
  const { service } = makeService();
  await seedStage(service);
  await service.startRound({ round_id: "round-2", rule_id: "rule-emerging", started_at: at(0.5) });
  await service.certifyResult({
    score_id: "score-2",
    round_id: "round-2",
    judge_id: "judge-2",
    entries: [
      { entry_id: "e3", participant_id: "team-alpha", value: 7.0 },
      { entry_id: "e4", participant_id: "team-beta", value: 9.0 },
    ],
  });
  await service.registerReviewer({ reviewer_id: "rev-rules", duty: "规则复核" });
  await service.registerReviewer({ reviewer_id: "rev-tech", duty: "技术复核" });

  const { case_id: caseId } = await service.fileAppeal({
    appeal_ref: "AP-20",
    appellant_id: "team-alpha",
    score_id: "score-2",
    claims: ["赛段设备未校准"],
  });
  await service.assignReviewer(caseId, "rev-rules");
  await service.assignReviewer(caseId, "rev-tech");
  await service.draftRuling(caseId, { outcome: "ANNUL_ROUND", rationale: "设备未校准，赛段结果不可用" });
  await service.signRuling(caseId, "rev-rules");
  await service.signRuling(caseId, "rev-tech");
  await service.issueRuling(caseId);

  await assert.rejects(
    () => service.publishRanking({ ranking_id: "rank-1", round_ids: ["round-1", "round-2"], ruling_refs: [] }),
    /必须引用生效裁决/,
  );
  const ranking = await service.publishRanking({ ranking_id: "rank-1", round_ids: ["round-1", "round-2"] });
  assert.deepEqual(ranking.ruling_refs, [caseId]);
  assert.deepEqual(ranking.excluded_rounds, [{ round_id: "round-2", case_id: caseId }]);
  assert.deepEqual(
    ranking.entries.map((entry) => [entry.participant_id, entry.total]),
    [["team-alpha", 9.5], ["team-beta", 8.0]],
    "被撤销赛段不计入排名",
  );
});

test("截止任务重启后按原时间继续，迟到证据只触发再审建议", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dispute-store-"));
  const path = join(dir, "store.json");
  let current = at(0);
  const clock = () => current;

  const first = new DisputeService({ store: new JsonFileStore(path), clock });
  await first.activateRule({ rule_id: "rule-emerging", rule_version: 3, effective_from: at(-2), expectations: [] });
  await first.startRound({ round_id: "round-1", rule_id: "rule-emerging", started_at: at(-1) });
  await first.certifyResult({
    score_id: "score-1",
    round_id: "round-1",
    judge_id: "judge-1",
    entries: [{ entry_id: "e1", participant_id: "team-alpha", value: 9.5 }],
  });
  await first.registerReviewer({ reviewer_id: "rev-rules", duty: "规则复核" });
  const { case_id: caseId, deadline } = await first.fileAppeal({
    appeal_ref: "AP-30",
    appellant_id: "team-beta",
    score_id: "score-1",
    claims: ["原判尺度存疑"],
  });
  assert.equal(deadline, at(48));
  await first.assignReviewer(caseId, "rev-rules");
  await first.draftRuling(caseId, { outcome: "UPHOLD", rationale: "证据不足，维持原判" });
  await first.signRuling(caseId, "rev-rules");
  await first.issueRuling(caseId);

  // 模拟重启：从同一存储文件重建服务
  const restarted = new DisputeService({ store: new JsonFileStore(path), clock });
  assert.deepEqual(restarted.pendingTasks(), [
    { task_id: `deadline:${caseId}`, kind: "appeal_evidence_window_close", case_id: caseId, due_at: at(48) },
  ]);
  current = at(50);
  const processed = await restarted.processDueTasks();
  assert.deepEqual(processed, [`deadline:${caseId}`]);
  const inspected = restarted.inspectCase(caseId);
  assert.equal(inspected.window_closed_at, at(48), "截止任务按原时间生效");
  assert.equal(inspected.ruling.outcome, "UPHOLD");

  // 逾期申诉不予受理
  await assert.rejects(
    () => restarted.fileAppeal({ appeal_ref: "AP-31", appellant_id: "team-alpha", score_id: "score-1", claims: ["逾期申诉"] }),
    /申诉逾期/,
  );

  // 迟到证据不进入在办材料，只触发再审建议，原裁决不变
  const late = await restarted.appendEvidence({
    case_id: caseId,
    source: "device:timer",
    collected_at: at(49),
    details: { seq: 7, measured: 11 },
  });
  assert.equal(late.late, true);
  const after = restarted.inspectCase(caseId);
  assert.equal(after.evidence.length, 0);
  assert.equal(after.late_evidence.length, 1);
  assert.equal(after.ruling.outcome, "UPHOLD");
  const suggestions = restarted.retrialSuggestions();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].case_id, caseId);
  assert.equal(suggestions[0].evidence_id, late.evidence_id);

  // 再次重启，截止任务不会重复触发
  const again = new DisputeService({ store: new JsonFileStore(path), clock });
  assert.deepEqual(await again.processDueTasks(), []);
  assert.equal(again.retrialSuggestions().length, 1, "再审建议随事件存储恢复");
});
