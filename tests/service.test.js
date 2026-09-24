import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DisputeAdjudicationService, DisputeError } from "../src/dispute-service.js";
import { FileEventStore, InMemoryEventStore } from "../src/event-store.js";
import { validateEvent } from "../src/validator.js";

const T0 = "2026-09-24T09:00:00.000Z";
const ONE_HOUR = 60 * 60 * 1000;

/** 可控时钟：测试通过 advance 推进时间。 */
function makeClock(start = T0) {
  let now = new Date(start);
  const clock = () => now;
  clock.advance = (ms) => {
    now = new Date(now.getTime() + ms);
  };
  return clock;
}

/** 手动计时器：记录截止任务的延时，由测试决定何时触发。 */
function manualTimers() {
  const tasks = new Map();
  let seq = 0;
  return {
    setTimeout: (fn, delay) => {
      const handle = ++seq;
      tasks.set(handle, { fn, delay });
      return handle;
    },
    clearTimeout: (handle) => {
      tasks.delete(handle);
    },
    delays: () => [...tasks.values()].map((task) => task.delay),
    size: () => tasks.size,
    runAll: () => {
      const fns = [...tasks.values()].map((task) => task.fn);
      tasks.clear();
      for (const fn of fns) fn();
    },
  };
}

/** 搭建基础事实：规则、赛段、三条设备消息、一版已认证成绩。 */
async function seed({ store = new InMemoryEventStore(), clock = makeClock(), timers = manualTimers(), appealWindowMs = ONE_HOUR } = {}) {
  const service = new DisputeAdjudicationService({ store, clock, appealWindowMs, timers });
  await service.activateRule({
    rule_id: "rule-1",
    rule_version: "2026.1",
    effective_from: "2026-09-01T00:00:00.000Z",
    device_checks: [
      { check_id: "seq_continuous" },
      { check_id: "value_range", params: { min: 0, max: 100 } },
    ],
    description: "2026 赛季计分规则",
  });
  await service.startRound({ round_id: "round-1", rule_id: "rule-1", name: "决赛赛段" });
  await service.recordDeviceMessage({ evidence_id: "evd-1", round_id: "round-1", device_id: "dev-1", vendor_id: "vendor-1", seq: 1, value: 88, collected_at: "2026-09-24T08:59:50.000Z" });
  await service.recordDeviceMessage({ evidence_id: "evd-2", round_id: "round-1", device_id: "dev-1", vendor_id: "vendor-1", seq: 2, value: 91, collected_at: "2026-09-24T08:59:55.000Z" });
  await service.recordDeviceMessage({ evidence_id: "evd-3", round_id: "round-1", device_id: "dev-1", vendor_id: "vendor-1", seq: 3, value: 85, collected_at: "2026-09-24T08:59:59.000Z" });
  await service.certifyResult({
    round_id: "round-1",
    entries: [
      { team: "team-A", score: 90 },
      { team: "team-B", score: 80 },
    ],
    judge_id: "judge-1",
  });
  return { service, clock, timers, store };
}

const appealInput = (overrides = {}) => ({
  appeal_no: "AP-2026-001",
  appellant: "team-A",
  round_id: "round-1",
  score_version: 1,
  grounds: "设备读数与公布成绩不符",
  materials: { statement: "申诉陈述", clips: ["clip-1"] },
  ...overrides,
});

async function seedWithReviewers() {
  const ctx = await seed();
  const { service } = ctx;
  await service.registerReviewer({ reviewer_id: "rev-1", role: "规则复核", conflicts: { teams: ["team-A"] } });
  await service.registerReviewer({ reviewer_id: "rev-2", role: "技术复核", conflicts: { judges: ["judge-1"] } });
  await service.registerReviewer({ reviewer_id: "rev-3", role: "技术复核", conflicts: { vendors: ["vendor-1"] } });
  await service.registerReviewer({ reviewer_id: "rev-4", role: "规则复核" });
  await service.registerReviewer({ reviewer_id: "rev-5", role: "技术复核" });
  await service.registerReviewer({ reviewer_id: "rev-6", role: "规则复核" });
  return ctx;
}

test("受理申诉时冻结赛段、成绩版本与申诉时限", async () => {
  const { service } = await seed();
  const accepted = await service.fileAppeal(appealInput());
  assert.equal(accepted.case_id, "case-1");
  assert.equal(accepted.appeal_deadline, "2026-09-24T10:00:00.000Z"); // 认证时间 + 1 小时

  const state = await service.getCase("case-1");
  assert.equal(state.round_id, "round-1");
  assert.equal(state.score_version, 1);
  assert.equal(state.rule_version, "2026.1"); // 当时生效的规则版本一并冻结
  assert.equal(state.appeal_deadline, accepted.appeal_deadline);
  assert.equal(state.status, "open");
});

test("超过申诉时限的申诉不予受理", async () => {
  const { service, clock } = await seed();
  clock.advance(2 * ONE_HOUR);
  await assert.rejects(() => service.fileAppeal(appealInput()), (err) => {
    assert.equal(err.code, "APPEAL_WINDOW_EXPIRED");
    return true;
  });
});

test("重复申诉按内容识别，编号相同但材料变化时隔离待核", async () => {
  const { service } = await seed();
  const first = await service.fileAppeal(appealInput());
  const again = await service.fileAppeal(appealInput());
  assert.equal(again.duplicate, true);
  assert.equal(again.case_id, first.case_id);
  assert.equal((await service.listCases()).length, 1);

  // 编号相同、材料不同：隔离待核，不并入原案
  const changed = await service.fileAppeal(appealInput({ materials: { statement: "修改后的陈述" } }));
  assert.equal(changed.quarantined, true);
  const quarantines = await service.getQuarantines();
  assert.equal(quarantines.length, 1);
  assert.equal(quarantines[0].kind, "appeal");
  assert.equal(quarantines[0].conflicting_case_id, first.case_id);
  assert.equal((await service.listCases()).length, 1);
});

test("并发申诉：内容相同只立一案，内容不同各自立案且版本连续", async () => {
  const { service } = await seed();
  const same = await Promise.all(Array.from({ length: 5 }, () => service.fileAppeal(appealInput())));
  assert.deepEqual([...new Set(same.map((item) => item.case_id))], ["case-1"]);
  assert.equal((await service.listCases()).length, 1);

  const distinct = await Promise.all([1, 2, 3].map((n) => service.fileAppeal(appealInput({
    appeal_no: `AP-2026-10${n}`,
    materials: { statement: `第 ${n} 份陈述` },
  }))));
  assert.deepEqual(distinct.map((item) => item.case_id).sort(), ["case-2", "case-3", "case-4"]);

  // 每个聚合的事件版本从 1 开始连续递增
  const byAggregate = new Map();
  for (const event of await service.events()) {
    const key = `${event.aggregate_type}/${event.aggregate_id}`;
    if (!byAggregate.has(key)) byAggregate.set(key, []);
    byAggregate.get(key).push(event.version);
  }
  for (const versions of byAggregate.values()) {
    assert.deepEqual(versions, versions.map((_, index) => index + 1));
  }
});

test("离线证据回执按内容识别：同号同料为重复，同号异料隔离待核", async () => {
  const { service } = await seed();
  const { case_id } = await service.fileAppeal(appealInput());

  const first = await service.attachEvidence({
    case_id,
    source: "offline_receipt",
    collected_at: "2026-09-24T09:20:00.000Z",
    payload: { note: "线下封存设备日志" },
    receipt: { receipt_no: "RC-01", content_hash: "hash-a" },
  });
  assert.equal(first.evidence_ref, "case-1-ev1");

  const duplicate = await service.attachEvidence({
    case_id,
    source: "offline_receipt",
    collected_at: "2026-09-24T09:21:00.000Z",
    payload: { note: "同一批材料的重复回执" },
    receipt: { receipt_no: "RC-01", content_hash: "hash-a" },
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.evidence_ref, first.evidence_ref);

  const changed = await service.attachEvidence({
    case_id,
    source: "offline_receipt",
    collected_at: "2026-09-24T09:22:00.000Z",
    payload: { note: "同号但内容被改动" },
    receipt: { receipt_no: "RC-01", content_hash: "hash-b" },
  });
  assert.equal(changed.quarantined, true);

  const state = await service.getCase(case_id);
  assert.equal(state.evidence.length, 1); // 隔离材料未进入案件
  const quarantines = await service.getQuarantines();
  assert.equal(quarantines.length, 1);
  assert.equal(quarantines[0].kind, "evidence");
  assert.equal(quarantines[0].receipt_no, "RC-01");
});

test("自动规则比对只提出疑点，不形成结论", async () => {
  const { service } = await seed();
  const { case_id } = await service.fileAppeal(appealInput());

  const attach = await service.attachEvidence({
    case_id,
    source: "device",
    collected_at: "2026-09-24T09:10:00.000Z",
    payload: {
      messages: [
        { device_id: "dev-1", seq: 1, value: 50 },
        { device_id: "dev-1", seq: 2, value: 55 },
        { device_id: "dev-1", seq: 4, value: 150 }, // 序号缺口 + 读数超界
      ],
    },
  });
  assert.equal(attach.late, false);
  assert.equal(attach.doubts.length, 2);
  assert.ok(attach.doubts.some((d) => d.check_id === "value_range"));
  assert.ok(attach.doubts.some((d) => d.check_id === "seq_continuous"));

  // 重复追加同一批消息不产生重复疑点
  const again = await service.attachEvidence({
    case_id,
    source: "device",
    collected_at: "2026-09-24T09:11:00.000Z",
    payload: {
      messages: [
        { device_id: "dev-1", seq: 1, value: 50 },
        { device_id: "dev-1", seq: 2, value: 55 },
        { device_id: "dev-1", seq: 4, value: 150 },
      ],
    },
  });
  assert.equal(again.doubts.length, 0);

  const state = await service.getCase(case_id);
  assert.equal(state.doubts.length, 2);
  assert.equal(state.status, "open"); // 比对不影响案件状态
  assert.equal(state.ruling, null);
});

test("分配复核人员时排除与参赛方、原判和设备供应商的冲突者", async () => {
  const { service } = await seedWithReviewers();
  const { case_id } = await service.fileAppeal(appealInput());

  const { assigned, excluded } = await service.assignReviewers({
    case_id,
    candidate_ids: ["rev-1", "rev-2", "rev-3", "rev-4", "rev-5", "rev-9"],
  });
  assert.deepEqual(assigned.sort(), ["rev-4", "rev-5"]);

  const reasonOf = (id) => excluded.find((item) => item.reviewer_id === id).reasons.join();
  assert.match(reasonOf("rev-1"), /参赛方/);
  assert.match(reasonOf("rev-2"), /原判裁判/);
  assert.match(reasonOf("rev-3"), /设备供应商/);
  assert.match(reasonOf("rev-9"), /未登记/);

  const state = await service.getCase(case_id);
  assert.equal(state.screenings.length, 1); // 回避检查留痕
  assert.equal(state.reviewers.length, 2);
});

test("重大改判须由不同职责的两名复核人员签署", async () => {
  const { service } = await seedWithReviewers();
  const { case_id } = await service.fileAppeal(appealInput());
  await service.assignReviewers({ case_id, candidate_ids: ["rev-4", "rev-5", "rev-6"] });

  await service.signRuling({ case_id, reviewer_id: "rev-4", decision_type: "partial_recompute" });
  await assert.rejects(
    () => service.issueRuling({ case_id, type: "partial_recompute", recomputed_entries: [{ team: "team-A", score: 95 }] }),
    (err) => err.code === "QUORUM_NOT_MET",
  );

  // 同职责的第二人签署仍不满足
  await service.signRuling({ case_id, reviewer_id: "rev-6", decision_type: "partial_recompute" });
  await assert.rejects(
    () => service.issueRuling({ case_id, type: "partial_recompute", recomputed_entries: [{ team: "team-A", score: 95 }] }),
    (err) => err.code === "QUORUM_NOT_MET",
  );

  // 不同职责（技术复核）签署后满足
  await service.signRuling({ case_id, reviewer_id: "rev-5", decision_type: "partial_recompute" });
  const { ruling_id } = await service.issueRuling({
    case_id,
    type: "partial_recompute",
    recomputed_entries: [{ team: "team-A", score: 95 }],
  });
  assert.equal(ruling_id, "ruling-1");
});

test("局部重算生成新成绩版本，旧成绩不被改写", async () => {
  const { service } = await seedWithReviewers();
  const { case_id } = await service.fileAppeal(appealInput());
  await service.assignReviewers({ case_id, candidate_ids: ["rev-4", "rev-5"] });
  await service.signRuling({ case_id, reviewer_id: "rev-4", decision_type: "partial_recompute" });
  await service.signRuling({ case_id, reviewer_id: "rev-5", decision_type: "partial_recompute" });

  const eventsBefore = (await service.events()).length;
  await service.issueRuling({
    case_id,
    type: "partial_recompute",
    recomputed_entries: [{ team: "team-A", score: 95 }],
    rationale: "设备缺口期间读数无效，按规则重算",
  });

  const original = await service.getScore("round-1", 1);
  assert.deepEqual(original.entries, [
    { team: "team-A", score: 90 },
    { team: "team-B", score: 80 },
  ]); // 旧版本原样保留
  assert.equal(original.status, "superseded");

  const corrected = await service.getEffectiveScore("round-1");
  assert.equal(corrected.score_version, 2);
  assert.deepEqual(corrected.entries, [
    { team: "team-A", score: 95 },
    { team: "team-B", score: 80 },
  ]); // 只重算申诉涉及的条目
  assert.equal(corrected.ruling_id, "ruling-1");

  // 历史只增不改：事件流只追加了裁决与更正
  const events = await service.events();
  assert.equal(events.length, eventsBefore + 2);
  assert.equal(events[events.length - 2].event_type, "RULING_ISSUED");
  assert.equal(events[events.length - 1].event_type, "SCORE_CORRECTED");
});

test("撤销赛段标记成绩作废，历史版本仍可查", async () => {
  const { service } = await seedWithReviewers();
  const { case_id } = await service.fileAppeal(appealInput());
  await service.assignReviewers({ case_id, candidate_ids: ["rev-4", "rev-5"] });
  await service.signRuling({ case_id, reviewer_id: "rev-4", decision_type: "annul_stage" });
  await service.signRuling({ case_id, reviewer_id: "rev-5", decision_type: "annul_stage" });
  await service.issueRuling({ case_id, type: "annul_stage", rationale: "设备供应商数据不可信" });

  const original = await service.getScore("round-1", 1);
  assert.equal(original.status, "annulled");
  assert.deepEqual(original.entries, [
    { team: "team-A", score: 90 },
    { team: "team-B", score: 80 },
  ]);

  const effective = await service.getEffectiveScore("round-1");
  assert.equal(effective.annulled, true);

  const published = await service.publishRanking({ round_ids: ["round-1"], ruling_refs: ["ruling-1"] });
  assert.equal(published.rounds[0].annulled, true);
});

test("维持裁决不生成更正，排名发布必须引用生效裁决", async () => {
  const { service } = await seedWithReviewers();

  // 无改判时排名可直接发布
  const plain = await service.publishRanking({ round_ids: ["round-1"] });
  assert.deepEqual(plain.rounds, [{ round_id: "round-1", score_version: 1, annulled: false }]);

  const { case_id } = await service.fileAppeal(appealInput());
  await service.assignReviewers({ case_id, candidate_ids: ["rev-4", "rev-5"] });

  // 维持：一名复核人员签署即可
  await service.signRuling({ case_id, reviewer_id: "rev-4", decision_type: "uphold" });
  await service.issueRuling({ case_id, type: "uphold" });
  assert.equal((await service.getEffectiveScore("round-1")).score_version, 1); // 无更正版本

  // 另一案改判后，排名必须引用裁决
  const second = await service.fileAppeal(appealInput({ appeal_no: "AP-2026-002", materials: { statement: "第二份陈述" } }));
  await service.assignReviewers({ case_id: second.case_id, candidate_ids: ["rev-4", "rev-5"] });
  await service.signRuling({ case_id: second.case_id, reviewer_id: "rev-4", decision_type: "partial_recompute" });
  await service.signRuling({ case_id: second.case_id, reviewer_id: "rev-5", decision_type: "partial_recompute" });
  const { ruling_id } = await service.issueRuling({
    case_id: second.case_id,
    type: "partial_recompute",
    recomputed_entries: [{ team: "team-B", score: 85 }],
  });

  await assert.rejects(
    () => service.publishRanking({ round_ids: ["round-1"] }),
    (err) => {
      assert.equal(err.code, "RULING_REFERENCE_MISSING");
      assert.match(err.message, new RegExp(ruling_id));
      return true;
    },
  );
  const published = await service.publishRanking({ round_ids: ["round-1"], ruling_refs: [ruling_id] });
  assert.equal(published.rounds[0].score_version, 2); // 排名采用更正后的生效版本
});

test("迟到证据只触发再审建议，再审可基于该证据改判", async () => {
  const { service, clock } = await seedWithReviewers();
  const { case_id } = await service.fileAppeal(appealInput());
  await service.assignReviewers({ case_id, candidate_ids: ["rev-4", "rev-5"] });
  await service.signRuling({ case_id, reviewer_id: "rev-4", decision_type: "uphold" });
  await service.issueRuling({ case_id, type: "uphold" });

  // 裁决作出后又有证据送到：只触发再审建议，不改动原裁决
  clock.advance(2 * ONE_HOUR);
  const late = await service.attachEvidence({
    case_id,
    source: "device",
    collected_at: "2026-09-24T11:30:00.000Z",
    payload: { messages: [{ device_id: "dev-1", seq: 3, value: 12 }] },
  });
  assert.equal(late.late, true);
  assert.ok(late.suggestion_id);

  const decided = await service.getCase(case_id);
  assert.equal(decided.ruling.type, "uphold");
  assert.equal(decided.suggestions.length, 1);

  // 开启再审：继承冻结对象，迟到证据转入新案
  const retrial = await service.openRetrial({ case_id });
  assert.equal(retrial.retrial_of, case_id);
  const retrialCase = await service.getCase(retrial.case_id);
  assert.equal(retrialCase.round_id, "round-1");
  assert.equal(retrialCase.score_version, 1);
  assert.equal(retrialCase.evidence.length, 1);
  assert.equal(retrialCase.evidence[0].late, false);

  // 再审走完整复核流程并改判
  await service.assignReviewers({ case_id: retrial.case_id, candidate_ids: ["rev-4", "rev-5"] });
  await service.signRuling({ case_id: retrial.case_id, reviewer_id: "rev-4", decision_type: "partial_recompute" });
  await service.signRuling({ case_id: retrial.case_id, reviewer_id: "rev-5", decision_type: "partial_recompute" });
  await service.issueRuling({
    case_id: retrial.case_id,
    type: "partial_recompute",
    recomputed_entries: [{ team: "team-A", score: 70 }],
  });

  const effective = await service.getEffectiveScore("round-1");
  assert.equal(effective.score_version, 2);
  assert.deepEqual(effective.entries, [
    { team: "team-A", score: 70 },
    { team: "team-B", score: 80 },
  ]);
  assert.equal((await service.getScore("round-1", 1)).entries[0].score, 90); // 原成绩仍未改写
});

test("截止任务在重启后按原时间继续", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispute-"));
  const path = join(dir, "events.jsonl");
  try {
    const clock = makeClock();
    const timersA = manualTimers();
    const a = new DisputeAdjudicationService({ store: new FileEventStore(path), clock, appealWindowMs: ONE_HOUR, timers: timersA });
    await a.activateRule({ rule_id: "rule-1", rule_version: "2026.1", effective_from: "2026-09-01T00:00:00.000Z" });
    await a.startRound({ round_id: "round-1", rule_id: "rule-1" });
    await a.certifyResult({ round_id: "round-1", entries: [{ team: "team-A", score: 90 }], judge_id: "judge-1" });
    const accepted = await a.fileAppeal(appealInput());
    assert.deepEqual(timersA.delays(), [ONE_HOUR]); // 截止任务按受理时冻结的时限武装

    // 20 分钟后服务重启：任务不得重新计时
    clock.advance(20 * 60 * 1000);
    await a.stop();
    assert.equal(timersA.size(), 0);

    const timersB = manualTimers();
    const b = new DisputeAdjudicationService({ store: new FileEventStore(path), clock, appealWindowMs: ONE_HOUR, timers: timersB });
    await b.ready();
    const restored = await b.getCase(accepted.case_id);
    assert.equal(restored.appeal_deadline, accepted.appeal_deadline); // 冻结的时限随事件恢复
    assert.deepEqual(timersB.delays(), [40 * 60 * 1000]); // 按原截止时间继续，只剩余 40 分钟

    // 到达原截止时间后任务触发，证据窗口关闭
    clock.advance(45 * 60 * 1000);
    timersB.runAll();
    await b.settled();
    const events = await b.events();
    assert.ok(events.some((event) => event.event_type === "APPEAL_WINDOW_CLOSED" && event.aggregate_id === accepted.case_id));

    // 窗口关闭后提交的证据按迟到处理
    const late = await b.attachEvidence({
      case_id: accepted.case_id,
      source: "device",
      collected_at: "2026-09-24T10:30:00.000Z",
      payload: { messages: [{ device_id: "dev-1", seq: 9, value: 1 }] },
    });
    assert.equal(late.late, true);
    await b.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("从一条成绩还原规则、设备证据、回避检查、签署与后续更正", async () => {
  const { service } = await seedWithReviewers();
  const { case_id } = await service.fileAppeal(appealInput());
  await service.assignReviewers({ case_id, candidate_ids: ["rev-1", "rev-4", "rev-5"] });
  await service.signRuling({ case_id, reviewer_id: "rev-4", decision_type: "partial_recompute" });
  await service.signRuling({ case_id, reviewer_id: "rev-5", decision_type: "partial_recompute" });
  await service.issueRuling({
    case_id,
    type: "partial_recompute",
    recomputed_entries: [{ team: "team-A", score: 95 }],
  });
  await service.publishRanking({ round_ids: ["round-1"], ruling_refs: ["ruling-1"] });

  const trace = await service.traceScore({ round_id: "round-1", score_version: 1 });
  assert.equal(trace.rule.rule_version, "2026.1");
  assert.equal(trace.device_evidence.length, 3);
  assert.equal(trace.appeals.length, 1);
  assert.equal(trace.appeals[0].case_id, case_id);
  assert.equal(trace.recusal_checks.length, 1);
  assert.ok(trace.recusal_checks[0].results.some((item) => item.reviewer_id === "rev-1" && !item.eligible));
  assert.equal(trace.signatures.length, 2);
  assert.deepEqual(trace.rulings.map((item) => item.type), ["partial_recompute"]);
  assert.equal(trace.corrections.length, 1);
  assert.equal(trace.corrections[0].score_version, 2);
  assert.equal(trace.corrections[0].corrects_version, 1);
  assert.equal(trace.corrections[0].ruling_id, "ruling-1");
});

test("服务产生的全部事件符合领域约定", async () => {
  const { service, clock } = await seedWithReviewers();
  const { case_id } = await service.fileAppeal(appealInput());
  await service.fileAppeal(appealInput({ materials: { statement: "异料同号" } }));
  await service.attachEvidence({
    case_id,
    source: "device",
    collected_at: "2026-09-24T09:05:00.000Z",
    payload: { messages: [{ device_id: "dev-1", seq: 5, value: 200 }] },
    receipt: { receipt_no: "RC-9", content_hash: "h1" },
  });
  await service.attachEvidence({
    case_id,
    source: "offline_receipt",
    collected_at: "2026-09-24T09:06:00.000Z",
    payload: {},
    receipt: { receipt_no: "RC-9", content_hash: "h2" },
  });
  await service.assignReviewers({ case_id, candidate_ids: ["rev-1", "rev-4", "rev-5"] });
  await service.signRuling({ case_id, reviewer_id: "rev-4", decision_type: "partial_recompute" });
  await service.signRuling({ case_id, reviewer_id: "rev-5", decision_type: "partial_recompute" });
  await service.issueRuling({ case_id, type: "partial_recompute", recomputed_entries: [{ team: "team-A", score: 95 }] });
  await service.publishRanking({ round_ids: ["round-1"], ruling_refs: ["ruling-1"] });
  clock.advance(2 * ONE_HOUR);
  await service.attachEvidence({ case_id, source: "device", collected_at: "2026-09-24T11:00:00.000Z", payload: {} });
  const retrial = await service.openRetrial({ case_id });
  await service.assignReviewers({ case_id: retrial.case_id, candidate_ids: ["rev-4", "rev-5"] });

  const events = await service.events();
  assert.ok(events.length >= 15);
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 应符合约定`);
  }
});

test("未知对象与非法操作返回带编码的错误", async () => {
  const { service } = await seed();
  await assert.rejects(() => service.fileAppeal(appealInput({ round_id: "nope" })), (err) => err.code === "UNKNOWN_ROUND");
  await assert.rejects(() => service.fileAppeal(appealInput({ score_version: 9 })), (err) => err.code === "UNKNOWN_SCORE");
  await assert.rejects(() => service.attachEvidence({ case_id: "case-x", source: "device", collected_at: T0 }), (err) => err.code === "UNKNOWN_CASE");
  const { case_id } = await service.fileAppeal(appealInput());
  await assert.rejects(() => service.signRuling({ case_id, reviewer_id: "ghost", decision_type: "uphold" }), (err) => err.code === "NOT_ASSIGNED");
  await assert.rejects(() => service.issueRuling({ case_id, type: "uphold" }), (err) => err.code === "QUORUM_NOT_MET");
  await assert.rejects(() => service.openRetrial({ case_id }), (err) => err.code === "CASE_NOT_DECIDED");
  assert.ok(new DisputeError("X", "y") instanceof Error);
});
