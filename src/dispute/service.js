import { contentFingerprint } from "./fingerprint.js";
import { evaluateExpectations } from "./rules.js";

const MAJOR_OUTCOMES = new Set(["PARTIAL_RECOMPUTE", "ANNUL_ROUND"]);
const OUTCOMES = new Set(["UPHOLD", ...MAJOR_OUTCOMES]);

/**
 * 争议裁决服务。
 *
 * 在追加式事件存储之上提供：申诉受理（冻结赛段、成绩版本、规则版本与申诉时限）、
 * 证据追加、自动规则比对（只提疑点）、复核人员回避分配、签署与裁决、
 * 排名发布引用生效裁决、迟到证据触发再审建议，以及从一条成绩还原完整裁决链。
 *
 * 所有变更方法经内部队列串行化，并发调用安全；重启后从存储恢复投影与截止任务。
 */
export class DisputeService {
  #store;
  #clock;
  #appealWindowMs;
  #tail = Promise.resolve();

  #aggVersions = new Map();
  #cases = new Map();
  #scores = new Map();
  #rounds = new Map();
  #rules = new Map();
  #deviceEvidence = new Map();
  #appealFingerprints = new Map();
  #appealRefs = new Map();
  #receipts = new Map();
  #quarantine = new Map();
  #rankings = [];
  #suggestions = [];

  constructor({ store, clock, appealWindowMs } = {}) {
    if (!store) throw new Error("必须提供事件存储");
    this.#store = store;
    this.#clock = clock ?? (() => new Date().toISOString());
    this.#appealWindowMs = appealWindowMs ?? 48 * 60 * 60 * 1000;
    this.#replay();
  }

  #lock(fn) {
    const run = this.#tail.then(fn);
    this.#tail = run.catch(() => {});
    return run;
  }

  // ---- 事件回放与投影 ----

  #replay() {
    for (const event of this.#store.events) this.#apply(event);
  }

  #emit(eventType, aggregateType, aggregateId, summary, payload) {
    const event = this.#store.append({
      event_id: `evt-${this.#store.events.length + 1}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.#clock(),
      version: (this.#aggVersions.get(`${aggregateType}:${aggregateId}`) ?? 0) + 1,
      summary,
      payload,
    });
    this.#apply(event);
    return event;
  }

  #apply(event) {
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    this.#aggVersions.set(key, (this.#aggVersions.get(key) ?? 0) + 1);
    const payload = event.payload ?? {};
    switch (event.event_type) {
      case "RULE_ACTIVATED": {
        const versions = this.#rules.get(event.aggregate_id) ?? [];
        versions.push({
          rule_version: payload.rule_version,
          effective_from: payload.effective_from,
          expectations: payload.expectations ?? [],
        });
        this.#rules.set(event.aggregate_id, versions);
        break;
      }
      case "ROUND_STARTED":
        this.#rounds.set(event.aggregate_id, {
          round_id: event.aggregate_id,
          rule_id: payload.rule_id ?? null,
          started_at: payload.started_at ?? event.occurred_at,
          annulled: false,
          annulled_by: null,
        });
        break;
      case "EVIDENCE_RECORDED": {
        const list = this.#deviceEvidence.get(payload.round_id) ?? [];
        list.push({
          evidence_id: event.aggregate_id,
          round_id: payload.round_id,
          device_id: payload.device_id ?? null,
          vendor_id: payload.vendor_id ?? null,
          source: payload.source,
          collected_at: payload.collected_at,
          details: payload.details ?? {},
        });
        this.#deviceEvidence.set(payload.round_id, list);
        break;
      }
      case "RESULT_CERTIFIED":
        this.#pushScoreVersion(event.aggregate_id, {
          version: event.version,
          round_id: payload.round_id,
          judge_id: payload.judge_id ?? null,
          entries: payload.entries ?? [],
          certified_at: event.occurred_at,
          supersedes: null,
          basis_version: null,
          caused_by: null,
        });
        break;
      case "SCORE_RECOMPUTED":
        this.#pushScoreVersion(event.aggregate_id, {
          version: event.version,
          round_id: payload.round_id,
          judge_id: payload.judge_id ?? null,
          entries: payload.entries ?? [],
          certified_at: event.occurred_at,
          supersedes: payload.supersedes ?? null,
          basis_version: payload.basis_version ?? null,
          caused_by: payload.caused_by ?? null,
        });
        break;
      case "ROUND_ANNULLED": {
        const round = this.#rounds.get(event.aggregate_id) ?? {
          round_id: event.aggregate_id,
          rule_id: null,
          started_at: null,
        };
        round.annulled = true;
        round.annulled_by = payload.case_id ?? null;
        this.#rounds.set(event.aggregate_id, round);
        break;
      }
      case "APPEAL_ACCEPTED":
        this.#cases.set(event.aggregate_id, {
          case_id: event.aggregate_id,
          appeal_ref: payload.appeal_ref,
          appellant_id: payload.appellant_id,
          round_id: payload.round_id,
          score_id: payload.score_id,
          score_version: payload.score_version,
          rule: payload.rule ?? null,
          claims: payload.claims ?? [],
          fingerprint: payload.fingerprint,
          deadline: payload.deadline,
          retrial_of: payload.retrial_of ?? null,
          resolved_from: payload.resolved_from ?? null,
          accepted_at: event.occurred_at,
          status: "under_review",
          evidence: [],
          late_evidence: [],
          doubts: [],
          reviewers: [],
          draft: null,
          signatures: [],
          ruling: null,
          suggestions: [],
          window_closed_at: null,
        });
        this.#appealFingerprints.set(payload.fingerprint, event.aggregate_id);
        if (!this.#appealRefs.has(payload.appeal_ref)) {
          this.#appealRefs.set(payload.appeal_ref, payload.fingerprint);
        }
        break;
      case "APPEAL_EVIDENCE_APPENDED": {
        const target = this.#cases.get(event.aggregate_id);
        if (!target) break;
        (payload.evidence?.late ? target.late_evidence : target.evidence).push(payload.evidence);
        if (payload.receipt_id) {
          this.#receipts.set(payload.receipt_id, {
            fingerprint: payload.receipt_fingerprint,
            evidence_id: payload.evidence.evidence_id,
          });
        }
        break;
      }
      case "EVIDENCE_WINDOW_CLOSED": {
        const target = this.#cases.get(event.aggregate_id);
        if (target) target.window_closed_at = payload.effective_at;
        break;
      }
      case "RULE_DOUBT_RAISED": {
        const target = this.#cases.get(event.aggregate_id);
        if (target) target.doubts = payload.doubts ?? [];
        break;
      }
      case "REVIEWER_ASSIGNED": {
        const target = this.#cases.get(event.aggregate_id);
        if (target) {
          target.reviewers.push({
            reviewer_id: payload.reviewer_id,
            duty: payload.duty,
            conflict_check: payload.conflict_check,
          });
        }
        break;
      }
      case "RULING_DRAFTED": {
        const target = this.#cases.get(event.aggregate_id);
        if (target) {
          target.draft = {
            outcome: payload.outcome,
            rationale: payload.rationale ?? "",
            corrections: payload.corrections ?? [],
          };
        }
        break;
      }
      case "RULING_SIGNED": {
        const target = this.#cases.get(event.aggregate_id);
        if (target) {
          target.signatures.push({
            reviewer_id: payload.reviewer_id,
            duty: payload.duty,
            signed_at: event.occurred_at,
          });
        }
        break;
      }
      case "RULING_ISSUED": {
        const target = this.#cases.get(event.aggregate_id);
        if (target) {
          target.ruling = {
            outcome: payload.outcome,
            rationale: payload.rationale ?? "",
            corrections: payload.corrections ?? [],
            signatures: payload.signatures ?? [],
            issued_at: event.occurred_at,
          };
          target.status = "ruled";
        }
        break;
      }
      case "RANKING_PUBLISHED":
        this.#rankings.push({ ranking_id: event.aggregate_id, ...payload, published_at: event.occurred_at });
        break;
      case "RETRIAL_SUGGESTED": {
        const suggestion = {
          case_id: event.aggregate_id,
          evidence_id: payload.evidence_id,
          reason: payload.reason,
          suggested_at: event.occurred_at,
        };
        this.#suggestions.push(suggestion);
        this.#cases.get(event.aggregate_id)?.suggestions.push(suggestion);
        break;
      }
      case "SUBMISSION_QUARANTINED":
        this.#quarantine.set(payload.submission_key, {
          submission_key: payload.submission_key,
          kind: payload.kind,
          ref: payload.ref,
          fingerprint: payload.fingerprint,
          content: payload.content,
          reason: payload.reason,
          status: "pending",
          quarantined_at: event.occurred_at,
          resolution: null,
        });
        break;
      case "QUARANTINE_RESOLVED": {
        const record = this.#quarantine.get(payload.submission_key);
        if (record) {
          record.status = payload.admit ? "admitted" : "rejected";
          record.resolution = {
            admit: payload.admit,
            reason: payload.reason ?? null,
            resolved_at: event.occurred_at,
          };
        }
        break;
      }
      default:
        break;
    }
  }

  #pushScoreVersion(scoreId, version) {
    const score = this.#scores.get(scoreId) ?? { score_id: scoreId, versions: [] };
    score.versions.push(version);
    this.#scores.set(scoreId, score);
  }

  // ---- 内部查询 ----

  #getCase(caseId) {
    const target = this.#cases.get(caseId);
    if (!target) throw new Error(`申诉案件不存在：${caseId}`);
    return target;
  }

  #getScore(scoreId) {
    const score = this.#scores.get(scoreId);
    if (!score) throw new Error(`成绩不存在：${scoreId}`);
    return score;
  }

  #scoreVersion(scoreId, version) {
    const score = this.#getScore(scoreId);
    const found = score.versions.find((item) => item.version === version);
    if (!found) throw new Error(`成绩 ${scoreId} 不存在第 ${version} 版`);
    return found;
  }

  /** 当时生效的规则版本：生效时间不晚于参照时间的最高版本。 */
  #ruleFor(roundId, at) {
    const round = this.#rounds.get(roundId);
    if (!round?.rule_id) return null;
    const active = (this.#rules.get(round.rule_id) ?? [])
      .filter((item) => !item.effective_from || item.effective_from <= at)
      .sort((left, right) => String(left.effective_from).localeCompare(String(right.effective_from)))
      .at(-1);
    return active ? { rule_id: round.rule_id, rule_version: active.rule_version, expectations: active.expectations } : null;
  }

  /** 回避检查上下文：参赛方（申诉人与成绩条目）、原判裁判、设备供应商。 */
  #conflictContext(target) {
    const score = this.#scores.get(target.score_id);
    const version = score?.versions.find((item) => item.version === target.score_version) ?? score?.versions.at(-1);
    const participants = new Set([target.appellant_id]);
    for (const entry of version?.entries ?? []) {
      if (entry.participant_id) participants.add(entry.participant_id);
    }
    const judges = new Set();
    if (version?.judge_id) judges.add(version.judge_id);
    const vendors = new Set();
    for (const item of this.#deviceEvidence.get(target.round_id) ?? []) {
      if (item.vendor_id) vendors.add(item.vendor_id);
    }
    return { participants: [...participants], judges: [...judges], vendors: [...vendors] };
  }

  // ---- 基础数据登记 ----

  async registerReviewer(reviewer) {
    return this.#lock(() => {
      if (!reviewer?.reviewer_id) throw new Error("复核人员缺少标识");
      if (!reviewer?.duty) throw new Error("复核人员缺少职责");
      this.#store.directories.reviewers[reviewer.reviewer_id] = {
        reviewer_id: reviewer.reviewer_id,
        name: reviewer.name ?? reviewer.reviewer_id,
        duty: reviewer.duty,
        conflicts: {
          participants: [...(reviewer.conflicts?.participants ?? [])],
          judges: [...(reviewer.conflicts?.judges ?? [])],
          vendors: [...(reviewer.conflicts?.vendors ?? [])],
        },
      };
      this.#store.persist();
      return { reviewer_id: reviewer.reviewer_id, duty: reviewer.duty };
    });
  }

  async activateRule(input) {
    return this.#lock(() => {
      if (!input?.rule_id) throw new Error("规则缺少标识");
      this.#emit(
        "RULE_ACTIVATED",
        "competition_rule",
        input.rule_id,
        input.summary ?? `激活规则 ${input.rule_id} 第 ${input.rule_version} 版`,
        {
          rule_version: input.rule_version,
          effective_from: input.effective_from ?? null,
          expectations: input.expectations ?? [],
        },
      );
      return { rule_id: input.rule_id, rule_version: input.rule_version };
    });
  }

  async startRound(input) {
    return this.#lock(() => {
      if (!input?.round_id) throw new Error("赛段缺少标识");
      this.#emit("ROUND_STARTED", "contest_round", input.round_id, input.summary ?? `赛段 ${input.round_id} 开始`, {
        rule_id: input.rule_id ?? null,
        started_at: input.started_at ?? this.#clock(),
      });
      return { round_id: input.round_id };
    });
  }

  async recordDeviceEvidence(input) {
    return this.#lock(() => {
      if (!input?.evidence_id) throw new Error("设备消息缺少标识");
      if (!input?.round_id) throw new Error("设备消息缺少赛段");
      this.#emit(
        "EVIDENCE_RECORDED",
        "score_evidence",
        input.evidence_id,
        input.summary ?? `记录设备消息 ${input.evidence_id}`,
        {
          round_id: input.round_id,
          device_id: input.device_id ?? null,
          vendor_id: input.vendor_id ?? null,
          source: input.source ?? `device:${input.device_id ?? "unknown"}`,
          collected_at: input.collected_at ?? this.#clock(),
          details: input.details ?? {},
        },
      );
      return { evidence_id: input.evidence_id };
    });
  }

  async certifyResult(input) {
    return this.#lock(() => {
      if (!input?.score_id) throw new Error("成绩缺少标识");
      if (this.#scores.has(input.score_id)) throw new Error(`成绩已存在，不得重写：${input.score_id}`);
      this.#emit("RESULT_CERTIFIED", "score_result", input.score_id, input.summary ?? `确认成绩 ${input.score_id}`, {
        round_id: input.round_id,
        judge_id: input.judge_id ?? null,
        entries: input.entries ?? [],
      });
      return { score_id: input.score_id, version: 1 };
    });
  }

  // ---- 申诉受理与证据 ----

  async fileAppeal(input) {
    return this.#lock(() => this.#fileAppeal(input, null));
  }

  #fileAppeal(input, resolvedFrom) {
    if (!input?.appeal_ref) throw new Error("申诉缺少编号");
    if (!input?.score_id) throw new Error("申诉缺少所针对的成绩");
    const score = this.#getScore(input.score_id);
    const target = score.versions[score.versions.length - 1];
    if (input.round_id && input.round_id !== target.round_id) {
      throw new Error(`申诉赛段与成绩所属赛段不符：${input.round_id}`);
    }
    const content = {
      appellant_id: input.appellant_id,
      round_id: target.round_id,
      score_id: input.score_id,
      claims: input.claims ?? [],
    };
    const fingerprint = contentFingerprint(content);

    // 重复申诉按内容识别：内容相同直接归并到既有案件。
    const duplicated = this.#appealFingerprints.get(fingerprint);
    if (duplicated) return { case_id: duplicated, duplicate: true };

    // 编号相同但材料变化：隔离待核，不进入裁决流程。
    const refFingerprint = this.#appealRefs.get(input.appeal_ref);
    if (!resolvedFrom && refFingerprint && refFingerprint !== fingerprint) {
      return this.#quarantineSubmission(
        `appeal:${input.appeal_ref}`,
        "appeal",
        input.appeal_ref,
        fingerprint,
        content,
        `申诉编号 ${input.appeal_ref} 已对应其他材料`,
      );
    }

    const now = this.#clock();
    const deadline = new Date(Date.parse(target.certified_at) + this.#appealWindowMs).toISOString();
    if (now > deadline) throw new Error(`申诉逾期：时限 ${deadline}`);

    const caseId = `appeal-case-${String(this.#cases.size + 1).padStart(4, "0")}`;
    const rule = this.#ruleFor(target.round_id, target.certified_at);
    this.#emit(
      "APPEAL_ACCEPTED",
      "appeal_case",
      caseId,
      `受理申诉 ${input.appeal_ref}，冻结赛段 ${target.round_id} 成绩第 ${target.version} 版`,
      {
        appeal_ref: input.appeal_ref,
        appellant_id: content.appellant_id,
        round_id: target.round_id,
        score_id: content.score_id,
        score_version: target.version,
        claims: content.claims,
        fingerprint,
        deadline,
        rule: rule ? { rule_id: rule.rule_id, rule_version: rule.rule_version } : null,
        retrial_of: input.retrial_of ?? null,
        resolved_from: resolvedFrom,
      },
    );
    this.#store.scheduleTask({
      task_id: `deadline:${caseId}`,
      kind: "appeal_evidence_window_close",
      case_id: caseId,
      due_at: deadline,
    });
    return { case_id: caseId, deadline, duplicate: false };
  }

  async appendEvidence(input) {
    return this.#lock(() => this.#appendEvidence(input));
  }

  #appendEvidence(input) {
    const target = this.#getCase(input.case_id);
    if (!input?.source) throw new Error("证据缺少来源");
    const now = this.#clock();
    // 迟到证据不进入在办材料，只触发再审建议。
    const late = now > target.deadline;
    const evidence = {
      evidence_id: input.evidence_id ?? `ev-${target.case_id}-${target.evidence.length + target.late_evidence.length + 1}`,
      source: input.source,
      collected_at: input.collected_at ?? now,
      details: input.details ?? {},
      late,
    };
    this.#emit(
      "APPEAL_EVIDENCE_APPENDED",
      "appeal_case",
      target.case_id,
      late ? `登记迟到证据 ${evidence.evidence_id}` : `追加证据 ${evidence.evidence_id}`,
      {
        case_id: target.case_id,
        evidence,
        receipt_id: input.receipt_id ?? null,
        receipt_fingerprint: input.receipt_fingerprint ?? null,
      },
    );
    if (late) {
      this.#emit(
        "RETRIAL_SUGGESTED",
        "appeal_case",
        target.case_id,
        `迟到证据 ${evidence.evidence_id} 触发再审建议`,
        {
          case_id: target.case_id,
          evidence_id: evidence.evidence_id,
          reason: "证据在申诉时限之后提交，仅触发再审建议",
        },
      );
    }
    return { evidence_id: evidence.evidence_id, late };
  }

  /** 离线证据回执：按内容识别重复，编号相同但材料变化时隔离待核。 */
  async submitOfflineReceipt(input) {
    return this.#lock(() => {
      if (!input?.receipt_id) throw new Error("回执缺少编号");
      const content = {
        case_id: input.case_id,
        source: input.source,
        collected_at: input.collected_at,
        details: input.details ?? {},
      };
      const fingerprint = contentFingerprint(content);
      const existing = this.#receipts.get(input.receipt_id);
      if (existing && existing.fingerprint === fingerprint) {
        return { evidence_id: existing.evidence_id, duplicate: true };
      }
      if (existing) {
        return this.#quarantineSubmission(
          `receipt:${input.receipt_id}`,
          "receipt",
          input.receipt_id,
          fingerprint,
          content,
          `回执编号 ${input.receipt_id} 的材料发生变化`,
        );
      }
      const result = this.#appendEvidence({ ...content, receipt_id: input.receipt_id, receipt_fingerprint: fingerprint });
      return { evidence_id: result.evidence_id, late: result.late, duplicate: false };
    });
  }

  #quarantineSubmission(submissionKey, kind, ref, fingerprint, content, reason) {
    const existing = this.#quarantine.get(submissionKey);
    if (existing && existing.fingerprint === fingerprint && existing.status === "pending") {
      return { quarantined: true, submission_key: submissionKey, duplicate: true };
    }
    this.#emit(
      "SUBMISSION_QUARANTINED",
      kind === "appeal" ? "appeal_case" : "score_evidence",
      ref,
      `隔离待核：${reason}`,
      { submission_key: submissionKey, kind, ref, fingerprint, content, reason },
    );
    return { quarantined: true, submission_key: submissionKey };
  }

  async resolveQuarantine(submissionKey, decision) {
    return this.#lock(() => {
      const record = this.#quarantine.get(submissionKey);
      if (!record) throw new Error(`隔离记录不存在：${submissionKey}`);
      if (record.status !== "pending") throw new Error(`隔离记录已处理：${submissionKey}`);
      const admit = decision?.admit === true;
      this.#emit(
        "QUARANTINE_RESOLVED",
        record.kind === "appeal" ? "appeal_case" : "score_evidence",
        record.ref,
        `隔离${admit ? "采纳" : "驳回"}：${record.ref}`,
        { submission_key: submissionKey, admit, reason: decision?.reason ?? null },
      );
      if (!admit) return { resolved: true, admitted: false };
      if (record.kind === "appeal") {
        const result = this.#fileAppeal({ appeal_ref: record.ref, ...record.content }, submissionKey);
        return { resolved: true, admitted: true, case_id: result.case_id };
      }
      const result = this.#appendEvidence({
        ...record.content,
        receipt_id: record.ref,
        receipt_fingerprint: record.fingerprint,
      });
      return { resolved: true, admitted: true, evidence_id: result.evidence_id };
    });
  }

  // ---- 规则比对与复核 ----

  /** 自动规则比对：对照冻结的规则版本检查在办证据，只提出疑点。 */
  async runRuleCheck(caseId) {
    return this.#lock(() => {
      const target = this.#getCase(caseId);
      const expectations = target.rule
        ? (this.#rules.get(target.rule.rule_id) ?? []).find((item) => item.rule_version === target.rule.rule_version)
            ?.expectations ?? []
        : [];
      const doubts = evaluateExpectations(expectations, target.evidence);
      this.#emit("RULE_DOUBT_RAISED", "appeal_case", target.case_id, `规则比对提出 ${doubts.length} 项疑点`, {
        case_id: target.case_id,
        rule: target.rule,
        doubts,
      });
      return doubts;
    });
  }

  /** 分配复核人员：与参赛方、原判、设备供应商存在冲突者排除。 */
  async assignReviewer(caseId, reviewerId) {
    return this.#lock(() => {
      const target = this.#getCase(caseId);
      const reviewer = this.#store.directories.reviewers[reviewerId];
      if (!reviewer) throw new Error(`复核人员未登记：${reviewerId}`);
      if (target.reviewers.some((item) => item.reviewer_id === reviewerId)) {
        throw new Error(`复核人员已分配：${reviewerId}`);
      }
      const context = this.#conflictContext(target);
      const hits = [];
      for (const kind of ["participants", "judges", "vendors"]) {
        for (const id of reviewer.conflicts[kind]) {
          if (context[kind].includes(id)) hits.push(`${kind}:${id}`);
        }
      }
      if (hits.length > 0) {
        throw new Error(`复核人员存在回避冲突：${hits.join("，")}`);
      }
      this.#emit("REVIEWER_ASSIGNED", "appeal_case", target.case_id, `分配复核人员 ${reviewerId}`, {
        case_id: target.case_id,
        reviewer_id: reviewerId,
        duty: reviewer.duty,
        conflict_check: { status: "passed", checked_against: context },
      });
      return { reviewer_id: reviewerId, duty: reviewer.duty };
    });
  }

  async draftRuling(caseId, input) {
    return this.#lock(() => {
      const target = this.#getCase(caseId);
      if (target.status !== "under_review") throw new Error(`案件已裁决，不得重复起草：${caseId}`);
      if (!OUTCOMES.has(input?.outcome)) throw new Error(`未知裁决结果：${input?.outcome}`);
      const corrections = input.corrections ?? [];
      if (input.outcome === "PARTIAL_RECOMPUTE") {
        if (corrections.length === 0) throw new Error("局部重算必须给出更正条目");
        const basis = this.#scoreVersion(target.score_id, target.score_version);
        for (const correction of corrections) {
          if (!basis.entries.some((entry) => entry.entry_id === correction.entry_id)) {
            throw new Error(`更正条目不存在于冻结成绩：${correction.entry_id}`);
          }
        }
      }
      this.#emit("RULING_DRAFTED", "appeal_case", target.case_id, `起草裁决：${input.outcome}`, {
        case_id: target.case_id,
        outcome: input.outcome,
        rationale: input.rationale ?? "",
        corrections,
      });
      return { outcome: input.outcome };
    });
  }

  async signRuling(caseId, reviewerId) {
    return this.#lock(() => {
      const target = this.#getCase(caseId);
      if (!target.draft) throw new Error("尚未起草裁决");
      const assignment = target.reviewers.find((item) => item.reviewer_id === reviewerId);
      if (!assignment) throw new Error(`复核人员未分配到案件：${reviewerId}`);
      if (target.signatures.some((item) => item.reviewer_id === reviewerId)) {
        throw new Error(`复核人员已签署：${reviewerId}`);
      }
      this.#emit("RULING_SIGNED", "appeal_case", target.case_id, `复核人员 ${reviewerId} 签署裁决`, {
        case_id: target.case_id,
        reviewer_id: reviewerId,
        duty: assignment.duty,
      });
      return { signed: true };
    });
  }

  /** 裁决生效：重大改判须由不同职责的两名复核人员签署。 */
  async issueRuling(caseId) {
    return this.#lock(() => {
      const target = this.#getCase(caseId);
      if (target.status !== "under_review") throw new Error(`案件已裁决：${caseId}`);
      if (!target.draft) throw new Error("尚未起草裁决");
      const outcome = target.draft.outcome;
      const duties = new Set(target.signatures.map((item) => item.duty));
      if (MAJOR_OUTCOMES.has(outcome)) {
        if (target.signatures.length < 2 || duties.size < 2) {
          throw new Error("重大改判须由不同职责的两名复核人员签署");
        }
      } else if (target.signatures.length < 1) {
        throw new Error("裁决须至少一名复核人员签署");
      }
      const issued = this.#emit("RULING_ISSUED", "appeal_case", target.case_id, `裁决生效：${outcome}`, {
        case_id: target.case_id,
        outcome,
        rationale: target.draft.rationale,
        corrections: target.draft.corrections,
        signatures: target.signatures,
        score_id: target.score_id,
        score_version: target.score_version,
        round_id: target.round_id,
      });
      if (outcome === "PARTIAL_RECOMPUTE") this.#recomputeScore(target);
      if (outcome === "ANNUL_ROUND") {
        this.#emit("ROUND_ANNULLED", "contest_round", target.round_id, `撤销赛段 ${target.round_id}`, {
          case_id: target.case_id,
          round_id: target.round_id,
        });
      }
      return { outcome, issued_at: issued.occurred_at };
    });
  }

  /** 局部重算：基于冻结版本生成新的成绩版本，旧成绩保持原样。 */
  #recomputeScore(target) {
    const basis = this.#scoreVersion(target.score_id, target.score_version);
    const corrections = new Map(target.draft.corrections.map((item) => [item.entry_id, item]));
    const entries = basis.entries.map((entry) => {
      const correction = corrections.get(entry.entry_id);
      return correction ? { ...entry, value: correction.value, correction_reason: correction.reason ?? null } : { ...entry };
    });
    const latest = score_latest(this.#getScore(target.score_id));
    this.#emit(
      "SCORE_RECOMPUTED",
      "score_result",
      target.score_id,
      `局部重算成绩 ${target.score_id}（依据 ${target.case_id}）`,
      {
        round_id: basis.round_id,
        entries,
        supersedes: latest.version,
        basis_version: target.score_version,
        caused_by: target.case_id,
      },
    );
  }

  // ---- 排名发布 ----

  /** 发布排名：统计未撤销赛段的最新成绩版本，并强制引用生效裁决。 */
  async publishRanking(input) {
    return this.#lock(() => {
      if (!input?.ranking_id) throw new Error("排名缺少标识");
      if (this.#rankings.some((item) => item.ranking_id === input.ranking_id)) {
        throw new Error(`排名已发布：${input.ranking_id}`);
      }
      const roundIds = input.round_ids ?? [];
      const excluded = [];
      const totals = new Map();
      for (const roundId of roundIds) {
        const round = this.#rounds.get(roundId);
        if (round?.annulled) {
          excluded.push({ round_id: roundId, case_id: round.annulled_by });
          continue;
        }
        for (const score of this.#scores.values()) {
          const latest = score_latest(score);
          if (latest.round_id !== roundId) continue;
          for (const entry of latest.entries) {
            totals.set(entry.participant_id, (totals.get(entry.participant_id) ?? 0) + entry.value);
          }
        }
      }
      const entries = [...totals.entries()]
        .map(([participant_id, total]) => ({ participant_id, total }))
        .sort((left, right) => right.total - left.total || String(left.participant_id).localeCompare(String(right.participant_id)))
        .map((item, index) => ({ rank: index + 1, ...item }));
      const requiredRefs = [...this.#cases.values()]
        .filter((item) => item.status === "ruled" && roundIds.includes(item.round_id))
        .map((item) => item.case_id)
        .sort();
      const provided = input.ruling_refs ? [...input.ruling_refs].sort() : null;
      if (provided && requiredRefs.some((ref) => !provided.includes(ref))) {
        throw new Error(`排名发布必须引用生效裁决：${requiredRefs.join("、")}`);
      }
      const payload = { round_ids: roundIds, entries, excluded_rounds: excluded, ruling_refs: requiredRefs };
      this.#emit(
        "RANKING_PUBLISHED",
        "ranking_publication",
        input.ranking_id,
        `发布排名 ${input.ranking_id}（引用 ${requiredRefs.length} 项生效裁决）`,
        payload,
      );
      return payload;
    });
  }

  // ---- 截止任务 ----

  /** 处理到期的截止任务；任务按原到期时间生效，重启后不重新计时。 */
  async processDueTasks() {
    return this.#lock(() => {
      const now = this.#clock();
      const closed = new Set(
        this.#store.events
          .filter((event) => event.event_type === "EVIDENCE_WINDOW_CLOSED")
          .map((event) => event.payload?.task_id),
      );
      const processed = [];
      for (const task of this.#store.tasks) {
        if (closed.has(task.task_id) || task.due_at > now) continue;
        this.#emit(
          "EVIDENCE_WINDOW_CLOSED",
          "appeal_case",
          task.case_id,
          `申诉时限 ${task.due_at} 到期，证据窗口关闭`,
          { task_id: task.task_id, case_id: task.case_id, effective_at: task.due_at },
        );
        processed.push(task.task_id);
      }
      return processed;
    });
  }

  // ---- 只读查询 ----

  inspectCase(caseId) {
    return structuredClone(this.#getCase(caseId));
  }

  quarantined() {
    return [...this.#quarantine.values()]
      .filter((item) => item.status === "pending")
      .map((item) => structuredClone(item));
  }

  retrialSuggestions() {
    return this.#suggestions.map((item) => structuredClone(item));
  }

  pendingTasks() {
    const closed = new Set(
      this.#store.events
        .filter((event) => event.event_type === "EVIDENCE_WINDOW_CLOSED")
        .map((event) => event.payload?.task_id),
    );
    return this.#store.tasks.filter((task) => !closed.has(task.task_id)).map((task) => ({ ...task }));
  }

  /** 从一条成绩还原规则、设备证据、回避检查、签署与后续更正。 */
  traceScore(scoreId) {
    const score = this.#getScore(scoreId);
    const first = score.versions[0];
    const rule = this.#ruleFor(first.round_id, first.certified_at);
    const appeals = [...this.#cases.values()]
      .filter((item) => item.score_id === scoreId)
      .map((item) => ({
        case_id: item.case_id,
        status: item.status,
        frozen: {
          round_id: item.round_id,
          score_version: item.score_version,
          deadline: item.deadline,
          rule: item.rule,
        },
        evidence: item.evidence,
        late_evidence: item.late_evidence,
        doubts: item.doubts,
        reviewers: item.reviewers,
        signatures: item.signatures,
        ruling: item.ruling,
        retrial_suggestions: item.suggestions,
      }));
    return structuredClone({
      score_id: scoreId,
      versions: score.versions,
      round: this.#rounds.get(first.round_id) ?? null,
      rule: rule ? { rule_id: rule.rule_id, rule_version: rule.rule_version } : null,
      device_evidence: this.#deviceEvidence.get(first.round_id) ?? [],
      appeals,
      corrections: score.versions.filter((item) => item.caused_by),
      rankings: this.#rankings.filter((item) => item.round_ids.includes(first.round_id)),
    });
  }
}

function score_latest(score) {
  return score.versions[score.versions.length - 1];
}
