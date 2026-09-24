/**
 * 争议裁决服务。
 *
 * 在既有事件约定之上提供可执行的复核流程：
 * - 受理申诉时冻结所针对的赛段、成绩版本与申诉时限；
 * - 证据按来源与采集时间追加，自动规则比对只提出疑点，不作结论；
 * - 复核人员按参赛方、原判裁判与设备供应商回避，重大改判须不同职责两人签署；
 * - 裁决可维持、局部重算或撤销赛段，只生成后继更正，不改写旧成绩；
 * - 迟到证据只触发再审建议；重复申诉与离线回执按内容识别，同号异料隔离待核；
 * - 截止任务由事件驱动，重启后按原时间继续；一条成绩可还原完整裁决链。
 */
import { contentFingerprint } from "./fingerprint.js";

export const RULING_TYPES = Object.freeze(["uphold", "partial_recompute", "annul_stage"]);

/** 重大改判：局部重算与撤销赛段，须由不同职责的两名复核人员签署。 */
const MAJOR_RULINGS = new Set(["partial_recompute", "annul_stage"]);

const DEFAULT_APPEAL_WINDOW_MS = 48 * 60 * 60 * 1000;

export class DisputeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DisputeError";
    this.code = code;
  }
}

function initialState() {
  return {
    rules: new Map(), // rule_id -> [{ rule_version, effective_from, device_checks }]
    rounds: new Map(), // round_id -> { round_id, rule_id, name, started_at }
    scores: new Map(), // round_id -> [成绩版本，含认证版与更正版]
    deviceMessages: new Map(), // evidence_id -> 设备原始消息
    reviewers: new Map(), // reviewer_id -> { role, conflicts }
    cases: new Map(), // case_id -> 案件状态
    appealIndex: new Map(), // appeal_no -> 首个案件 case_id
    fingerprintIndex: new Map(), // 内容指纹 -> case_id
    receipts: new Map(), // receipt_no -> { content_hash, evidence_ref, case_id }
    quarantines: [], // 隔离待核记录
    rankings: new Map(), // publication_id -> 排名发布
    versions: new Map(), // 聚合 -> 已用版本号
    counters: { case: 0, ruling: 0, suggestion: 0, quarantine: 0, publication: 0 },
  };
}

function bumpCounter(counters, key, id, prefix) {
  if (typeof id !== "string" || !id.startsWith(prefix)) return;
  const n = Number(id.slice(prefix.length));
  if (Number.isInteger(n) && n > counters[key]) counters[key] = n;
}

export class DisputeAdjudicationService {
  /**
   * @param {object} options
   * @param {object} options.store 事件存储（InMemoryEventStore / FileEventStore）。
   * @param {() => Date} [options.clock] 时钟，测试可注入可控时钟。
   * @param {number} [options.appealWindowMs] 申诉时限（自成绩认证起算），默认 48 小时。
   * @param {object} [options.timers] 计时器（setTimeout/clearTimeout 形态），测试可注入手动计时器。
   */
  constructor({ store, clock, appealWindowMs, timers } = {}) {
    if (!store) throw new DisputeError("STORE_REQUIRED", "必须提供事件存储");
    this._store = store;
    this._clock = clock ?? (() => new Date());
    this._appealWindowMs = appealWindowMs ?? DEFAULT_APPEAL_WINDOW_MS;
    this._timers = timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    };
    this._handles = new Set();
    this._chain = Promise.resolve();
    this._state = initialState();
    this._ready = this._load();
    this._ready.catch(() => {}); // 加载失败由后续命令表面化，避免未处理告警
  }

  /** 等待事件加载完成。 */
  ready() {
    return this._ready;
  }

  /** 等待已排队的命令（含截止任务）全部落盘。 */
  async settled() {
    await this._chain;
  }

  /** 停止全部截止任务计时器。 */
  stop() {
    for (const handle of this._handles) this._timers.clearTimeout(handle);
    this._handles.clear();
  }

  /** 读出存储中的全部事件。 */
  async events() {
    await this._ready;
    await this._chain;
    return this._store.loadAll();
  }

  // ---------------------------------------------------------------- 基础事实

  /** 登记一个规则版本及其生效时间。 */
  async activateRule({ rule_id, rule_version, effective_from, device_checks = [], description = null }) {
    return this._execute(async () => {
      if (!rule_id || !rule_version || !effective_from) {
        throw new DisputeError("FIELD_REQUIRED", "规则登记需要 rule_id、rule_version 与 effective_from");
      }
      await this._append("competition_rule", rule_id, "RULE_ACTIVATED", {
        rule_version,
        effective_from,
        device_checks,
        description,
      }, `登记规则 ${rule_id} 版本 ${rule_version}`);
      return { rule_id, rule_version };
    });
  }

  /** 开始一个赛段，并指明其适用的规则。 */
  async startRound({ round_id, rule_id = null, name = null }) {
    return this._execute(async () => {
      if (!round_id) throw new DisputeError("FIELD_REQUIRED", "缺少 round_id");
      await this._append("contest_round", round_id, "ROUND_STARTED", { rule_id, name }, `赛段 ${round_id} 开始`);
      return { round_id };
    });
  }

  /** 记录一条设备原始消息。 */
  async recordDeviceMessage({ evidence_id, round_id, device_id, vendor_id = null, seq, value, collected_at }) {
    return this._execute(async () => {
      this._mustRound(round_id);
      const id = evidence_id ?? `evd-${this._state.deviceMessages.size + 1}`;
      await this._append("score_evidence", id, "EVIDENCE_RECORDED", {
        round_id,
        device_id,
        vendor_id,
        seq,
        value,
        collected_at: collected_at ?? this._clock().toISOString(),
      }, `记录设备 ${device_id} 第 ${seq} 条原始消息`);
      return { evidence_id: id };
    });
  }

  /** 认证一个赛段的成绩版本。成绩一经认证不得改写，只能由裁决生成后继更正。 */
  async certifyResult({ round_id, entries, judge_id, certified_at }) {
    return this._execute(async () => {
      this._mustRound(round_id);
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new DisputeError("ENTRIES_REQUIRED", "成绩条目不能为空");
      }
      if (!judge_id) throw new DisputeError("FIELD_REQUIRED", "缺少原判裁判 judge_id");
      const score_version = this._nextScoreVersion(round_id);
      const at = certified_at ?? this._clock().toISOString();
      await this._append("contest_round", round_id, "RESULT_CERTIFIED", {
        score_version,
        entries: structuredClone(entries),
        judge_id,
        certified_at: at,
      }, `认证赛段 ${round_id} 第 ${score_version} 版成绩`);
      return { round_id, score_version };
    });
  }

  /** 登记复核人员及其回避关系申报。 */
  async registerReviewer({ reviewer_id, role, conflicts = {} }) {
    return this._execute(async () => {
      if (!reviewer_id || !role) throw new DisputeError("FIELD_REQUIRED", "复核人员需要 reviewer_id 与 role");
      await this._append("reviewer", reviewer_id, "REVIEWER_REGISTERED", {
        role,
        conflicts: {
          teams: conflicts.teams ?? [],
          judges: conflicts.judges ?? [],
          vendors: conflicts.vendors ?? [],
        },
      }, `登记复核人员 ${reviewer_id}（${role}）`);
      return { reviewer_id };
    });
  }

  // ---------------------------------------------------------------- 申诉受理

  /**
   * 受理申诉：冻结所针对的赛段、成绩版本与申诉时限。
   * 按内容识别重复申诉；编号相同但材料变化的申诉隔离待核。
   */
  async fileAppeal({ appeal_no, appellant, round_id, score_version, grounds, materials }) {
    return this._execute(async () => {
      if (!appeal_no || !appellant || !grounds) {
        throw new DisputeError("FIELD_REQUIRED", "申诉需要 appeal_no、appellant 与 grounds");
      }
      this._mustRound(round_id);
      const score = this._scoreOf(round_id, score_version);
      if (!score) throw new DisputeError("UNKNOWN_SCORE", `赛段 ${round_id} 没有第 ${score_version} 版成绩`);

      const fingerprint = contentFingerprint({ appellant, round_id, score_version, grounds, materials });
      const known = this._state.fingerprintIndex.get(fingerprint);
      if (known) return { case_id: known, duplicate: true };

      const existing = this._state.appealIndex.get(appeal_no);
      if (existing) {
        const quarantine_id = `quar-${++this._state.counters.quarantine}`;
        await this._append("appeal_case", quarantine_id, "APPEAL_QUARANTINED", {
          appeal_no,
          fingerprint,
          conflicting_case_id: existing,
          appellant,
          round_id,
          score_version,
          grounds,
          reason: "编号相同但材料变化",
        }, `申诉编号 ${appeal_no} 材料变化，隔离待核`);
        return { quarantined: true, quarantine_id };
      }

      const deadlineMs = new Date(score.certified_at).getTime() + this._appealWindowMs;
      if (this._clock().getTime() > deadlineMs) {
        throw new DisputeError("APPEAL_WINDOW_EXPIRED", "已超过申诉时限，不再受理");
      }
      const round = this._state.rounds.get(round_id);
      const rule = round.rule_id ? this._ruleInEffect(round.rule_id, score.certified_at) : null;
      const case_id = `case-${++this._state.counters.case}`;
      const appeal_deadline = new Date(deadlineMs).toISOString();
      await this._append("appeal_case", case_id, "APPEAL_ACCEPTED", {
        appeal_no,
        fingerprint,
        appellant,
        round_id,
        score_version,
        rule_id: round.rule_id ?? null,
        rule_version: rule?.rule_version ?? null,
        appeal_deadline,
        grounds,
        materials_hash: contentFingerprint(materials ?? null),
      }, `受理申诉 ${appeal_no}，冻结赛段 ${round_id} 第 ${score_version} 版成绩`);
      this._armDeadline(case_id);
      return { case_id, appeal_deadline, duplicate: false };
    });
  }

  /**
   * 向案件追加证据（按来源与采集时间记录）。
   * 超过冻结的申诉时限或案件已裁决时，证据标记为迟到，只触发再审建议。
   * 离线证据回执按内容识别：同号同料为重复，同号异料隔离待核。
   */
  async attachEvidence({ case_id, source, collected_at, payload = {}, receipt = null }) {
    return this._execute(async () => {
      const state = this._mustCase(case_id);
      if (!source || !collected_at) throw new DisputeError("FIELD_REQUIRED", "证据需要 source 与 collected_at");

      if (receipt) {
        const seen = this._state.receipts.get(receipt.receipt_no);
        if (seen && seen.content_hash === receipt.content_hash) {
          return { evidence_ref: seen.evidence_ref, duplicate: true, late: false };
        }
        if (seen) {
          await this._append("appeal_case", case_id, "EVIDENCE_QUARANTINED", {
            receipt_no: receipt.receipt_no,
            existing_hash: seen.content_hash,
            received_hash: receipt.content_hash,
            reason: "回执编号相同但材料变化",
          }, `离线回执 ${receipt.receipt_no} 材料变化，隔离待核`);
          return { quarantined: true };
        }
      }

      const late = state.status === "decided"
        || state.window_closed
        || this._clock().getTime() > new Date(state.appeal_deadline).getTime();
      const evidence_ref = `${case_id}-ev${state.evidence.length + 1}`;
      await this._append("appeal_case", case_id, "EVIDENCE_ATTACHED", {
        evidence_ref,
        source,
        collected_at,
        payload: structuredClone(payload),
        late,
        receipt_no: receipt?.receipt_no ?? null,
        content_hash: receipt?.content_hash ?? null,
      }, `追加${late ? "迟到" : ""}证据 ${evidence_ref}（来源：${source}）`);

      if (late) {
        const suggestion_id = `sug-${++this._state.counters.suggestion}`;
        await this._append("appeal_case", case_id, "RETRIAL_SUGGESTED", {
          suggestion_id,
          trigger_evidence: evidence_ref,
          reason: "late_evidence",
        }, `迟到证据 ${evidence_ref} 触发再审建议`);
        return { evidence_ref, late, suggestion_id, doubts: [] };
      }

      const doubts = source === "device" ? await this._compareWithRule(case_id) : [];
      return { evidence_ref, late, doubts };
    });
  }

  // ---------------------------------------------------------------- 复核与裁决

  /**
   * 为案件分配复核人员：排除与参赛方、原判裁判和设备供应商存在回避关系者，
   * 筛查结果留痕（RECUSAL_SCREENED），合格者写入 REVIEWER_ASSIGNED。
   */
  async assignReviewers({ case_id, candidate_ids }) {
    return this._execute(async () => {
      const state = this._mustOpenCase(case_id);
      const score = this._scoreOf(state.round_id, state.score_version);
      const teams = new Set([state.appellant, ...score.entries.map((entry) => entry.team)]);
      const judges = new Set([score.judge_id]);
      const vendors = new Set();
      for (const message of this._state.deviceMessages.values()) {
        if (message.round_id === state.round_id && message.vendor_id) vendors.add(message.vendor_id);
      }

      const results = candidate_ids.map((reviewer_id) => {
        const reviewer = this._state.reviewers.get(reviewer_id);
        const reasons = [];
        if (!reviewer) {
          reasons.push("未登记为复核人员");
        } else {
          const conflicts = reviewer.conflicts ?? {};
          if ((conflicts.teams ?? []).some((team) => teams.has(team))) reasons.push("与参赛方存在回避关系");
          if ((conflicts.judges ?? []).some((judge) => judges.has(judge))) reasons.push("与原判裁判存在回避关系");
          if ((conflicts.vendors ?? []).some((vendor) => vendors.has(vendor))) reasons.push("与设备供应商存在回避关系");
        }
        if (judges.has(reviewer_id)) reasons.push("原判裁判本人");
        return { reviewer_id, eligible: reasons.length === 0, reasons };
      });
      await this._append("appeal_case", case_id, "RECUSAL_SCREENED", { results }, `完成 ${candidate_ids.length} 名候选人的回避筛查`);

      const assigned = [];
      for (const result of results.filter((item) => item.eligible)) {
        if (state.reviewers.some((item) => item.reviewer_id === result.reviewer_id)) continue;
        const { role } = this._state.reviewers.get(result.reviewer_id);
        await this._append("appeal_case", case_id, "REVIEWER_ASSIGNED", {
          reviewer_id: result.reviewer_id,
          role,
        }, `指派复核人员 ${result.reviewer_id}（${role}）`);
        assigned.push(result.reviewer_id);
      }
      return { assigned, excluded: results.filter((item) => !item.eligible) };
    });
  }

  /** 复核人员签署裁决意向。 */
  async signRuling({ case_id, reviewer_id, decision_type }) {
    return this._execute(async () => {
      const state = this._mustOpenCase(case_id);
      if (!RULING_TYPES.includes(decision_type)) {
        throw new DisputeError("UNKNOWN_RULING_TYPE", `未知裁决类型：${decision_type}`);
      }
      const assignment = state.reviewers.find((item) => item.reviewer_id === reviewer_id);
      if (!assignment) throw new DisputeError("NOT_ASSIGNED", `复核人员 ${reviewer_id} 未指派到案件 ${case_id}`);
      if (state.signatures.some((item) => item.reviewer_id === reviewer_id)) {
        throw new DisputeError("ALREADY_SIGNED", `复核人员 ${reviewer_id} 已签署过`);
      }
      await this._append("appeal_case", case_id, "RULING_SIGNED", {
        reviewer_id,
        role: assignment.role,
        decision_type,
      }, `复核人员 ${reviewer_id} 签署 ${decision_type}`);
      return { signed: true };
    });
  }

  /**
   * 发布裁决：维持（uphold）、局部重算（partial_recompute）或撤销赛段（annul_stage）。
   * 重大改判须由不同职责的两名复核人员签署；改判只生成后继更正版本，不改写旧成绩。
   */
  async issueRuling({ case_id, type, recomputed_entries = null, rationale = null }) {
    return this._execute(async () => {
      const state = this._mustOpenCase(case_id);
      if (!RULING_TYPES.includes(type)) throw new DisputeError("UNKNOWN_RULING_TYPE", `未知裁决类型：${type}`);
      const supporters = state.signatures.filter((item) => item.decision_type === type);
      if (MAJOR_RULINGS.has(type)) {
        const roles = new Set(supporters.map((item) => item.role));
        if (supporters.length < 2 || roles.size < 2) {
          throw new DisputeError("QUORUM_NOT_MET", "重大改判须由不同职责的两名复核人员签署");
        }
      } else if (supporters.length < 1) {
        throw new DisputeError("QUORUM_NOT_MET", "维持裁决至少需一名复核人员签署");
      }

      const score = this._scoreOf(state.round_id, state.score_version);
      let correction = null;
      if (type === "partial_recompute") {
        if (!Array.isArray(recomputed_entries) || recomputed_entries.length === 0) {
          throw new DisputeError("RECOMPUTE_REQUIRED", "局部重算必须给出重算条目");
        }
        const knownTeams = new Set(score.entries.map((entry) => entry.team));
        for (const entry of recomputed_entries) {
          if (!knownTeams.has(entry.team)) {
            throw new DisputeError("UNKNOWN_TEAM", `成绩中不存在参赛方 ${entry.team}`);
          }
        }
        correction = {
          entries: score.entries.map((entry) => {
            const override = recomputed_entries.find((item) => item.team === entry.team);
            return override ? { ...entry, score: override.score } : { ...entry };
          }),
        };
      }
      if (type === "annul_stage") correction = { annulled: true };

      const ruling_id = `ruling-${++this._state.counters.ruling}`;
      await this._append("appeal_case", case_id, "RULING_ISSUED", {
        ruling_id,
        type,
        recomputed_entries: recomputed_entries ? structuredClone(recomputed_entries) : null,
        rationale,
        signatures: supporters.map((item) => ({ reviewer_id: item.reviewer_id, role: item.role })),
      }, `发布裁决 ${ruling_id}（${type}）`);

      if (correction) {
        const newVersion = this._nextScoreVersion(state.round_id);
        await this._append("contest_round", state.round_id, "SCORE_CORRECTED", {
          score_version: newVersion,
          corrects_version: state.score_version,
          ruling_id,
          ...correction,
        }, `依据裁决 ${ruling_id} 生成第 ${newVersion} 版更正成绩`);
      }
      return { ruling_id };
    });
  }

  /** 发布排名：凡涉及被改判赛段，必须引用生效裁决。 */
  async publishRanking({ publication_id, round_ids, ruling_refs = [] }) {
    return this._execute(async () => {
      if (!Array.isArray(round_ids) || round_ids.length === 0) {
        throw new DisputeError("FIELD_REQUIRED", "排名发布需要 round_ids");
      }
      const rounds = [];
      const required = new Set();
      for (const round_id of round_ids) {
        const versions = this._state.scores.get(round_id) ?? [];
        if (versions.length === 0) throw new DisputeError("NO_SCORE", `赛段 ${round_id} 没有已认证成绩`);
        const effective = versions[versions.length - 1];
        for (const version of versions) {
          if (version.kind === "correction") required.add(version.ruling_id);
        }
        rounds.push({
          round_id,
          score_version: effective.score_version,
          annulled: effective.annulled === true,
        });
      }
      const missing = [...required].filter((id) => !ruling_refs.includes(id));
      if (missing.length > 0) {
        throw new DisputeError("RULING_REFERENCE_MISSING", `排名发布必须引用生效裁决：${missing.join("、")}`);
      }
      const id = publication_id ?? `pub-${++this._state.counters.publication}`;
      await this._append("ranking_publication", id, "RANKING_PUBLISHED", {
        rounds,
        ruling_refs: [...ruling_refs],
      }, `发布排名并引用 ${ruling_refs.length} 项生效裁决`);
      return { publication_id: id, rounds };
    });
  }

  /** 依据再审建议开启再审：继承原案冻结对象，迟到证据转入新案。 */
  async openRetrial({ case_id }) {
    return this._execute(async () => {
      const original = this._mustCase(case_id);
      if (original.status !== "decided") throw new DisputeError("CASE_NOT_DECIDED", "只有已裁决的案件才能再审");
      if (original.suggestions.length === 0) throw new DisputeError("NO_RETRIAL_SUGGESTION", "没有再审建议，不能启动再审");
      const newId = `case-${++this._state.counters.case}`;
      const carried = original.evidence
        .filter((item) => item.late)
        .map((item) => ({
          evidence_ref: item.evidence_ref,
          source: item.source,
          collected_at: item.collected_at,
          payload: structuredClone(item.payload),
          carried_from: case_id,
        }));
      const appeal_deadline = new Date(this._clock().getTime() + this._appealWindowMs).toISOString();
      await this._append("appeal_case", newId, "RETRIAL_OPENED", {
        appeal_no: original.appeal_no,
        fingerprint: contentFingerprint({ retrial_of: case_id, suggestions: original.suggestions.map((item) => item.suggestion_id) }),
        appellant: original.appellant,
        round_id: original.round_id,
        score_version: original.score_version,
        rule_id: original.rule_id,
        rule_version: original.rule_version,
        appeal_deadline,
        grounds: original.grounds,
        retrial_of: case_id,
        suggestion_ids: original.suggestions.map((item) => item.suggestion_id),
        carried_evidence: carried,
      }, `针对案件 ${case_id} 启动再审 ${newId}`);
      this._armDeadline(newId);
      return { case_id: newId, retrial_of: case_id };
    });
  }

  // ---------------------------------------------------------------- 查询与溯源

  async getCase(case_id) {
    await this._ready;
    const state = this._state.cases.get(case_id);
    return state ? structuredClone(state) : null;
  }

  async listCases() {
    await this._ready;
    return [...this._state.cases.values()].map((state) => structuredClone(state));
  }

  async getScore(round_id, score_version) {
    await this._ready;
    const score = this._scoreOf(round_id, score_version);
    return score ? structuredClone(score) : null;
  }

  /** 某赛段当前生效的成绩版本（最新一版，可能是更正版）。 */
  async getEffectiveScore(round_id) {
    await this._ready;
    const versions = this._state.scores.get(round_id) ?? [];
    return versions.length ? structuredClone(versions[versions.length - 1]) : null;
  }

  async getQuarantines() {
    await this._ready;
    return structuredClone(this._state.quarantines);
  }

  /**
   * 从一条成绩还原完整裁决链：当时生效的规则、设备证据、
   * 回避检查、签署记录、裁决与后续更正。
   */
  async traceScore({ round_id, score_version }) {
    await this._ready;
    const score = this._scoreOf(round_id, score_version);
    if (!score) throw new DisputeError("UNKNOWN_SCORE", `赛段 ${round_id} 没有第 ${score_version} 版成绩`);
    const round = this._state.rounds.get(round_id);
    const rule = round?.rule_id ? this._ruleInEffect(round.rule_id, score.certified_at) : null;
    const cases = [...this._state.cases.values()]
      .filter((item) => item.round_id === round_id && item.score_version === score_version);

    const corrections = [];
    const versions = this._state.scores.get(round_id) ?? [];
    let cursor = score_version;
    for (;;) {
      const next = versions.find((item) => item.kind === "correction" && item.corrects_version === cursor);
      if (!next) break;
      corrections.push(next);
      cursor = next.score_version;
    }

    return structuredClone({
      round_id,
      score_version,
      score,
      rule: rule ? { rule_id: round.rule_id, rule_version: rule.rule_version, effective_from: rule.effective_from } : null,
      device_evidence: [...this._state.deviceMessages.values()].filter((item) => item.round_id === round_id),
      appeals: cases.map((item) => ({
        case_id: item.case_id,
        appeal_no: item.appeal_no,
        status: item.status,
        retrial_of: item.retrial_of,
        ruling: item.ruling,
      })),
      recusal_checks: cases.flatMap((item) => item.screenings.map((results) => ({ case_id: item.case_id, results }))),
      signatures: cases.flatMap((item) => item.signatures.map((sig) => ({ case_id: item.case_id, ...sig }))),
      rulings: cases.filter((item) => item.ruling).map((item) => ({ case_id: item.case_id, ...item.ruling })),
      corrections,
    });
  }

  // ---------------------------------------------------------------- 内部实现

  async _load() {
    const events = await this._store.loadAll();
    for (const event of events) this._apply(event);
    // 重启后按事件中的原截止时间重新武装截止任务
    for (const state of this._state.cases.values()) this._armDeadline(state.case_id);
  }

  _execute(fn) {
    const run = this._chain.then(async () => {
      await this._ready;
      return fn();
    });
    this._chain = run.catch(() => {});
    return run;
  }

  async _append(aggregate_type, aggregate_id, event_type, payload, summary) {
    const key = `${aggregate_type}/${aggregate_id}`;
    const version = (this._state.versions.get(key) ?? 0) + 1;
    const event = {
      event_id: `${key}#${version}`,
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at: this._clock().toISOString(),
      version,
      summary,
      payload,
    };
    await this._store.append(event);
    this._apply(event);
    return event;
  }

  _apply(event) {
    const state = this._state;
    const payload = event.payload ?? {};
    const key = `${event.aggregate_type}/${event.aggregate_id}`;
    state.versions.set(key, Math.max(state.versions.get(key) ?? 0, event.version));
    switch (event.event_type) {
      case "RULE_ACTIVATED": {
        const list = state.rules.get(event.aggregate_id) ?? [];
        list.push({
          rule_version: payload.rule_version,
          effective_from: payload.effective_from,
          device_checks: payload.device_checks ?? [],
          description: payload.description ?? null,
        });
        state.rules.set(event.aggregate_id, list);
        break;
      }
      case "ROUND_STARTED":
        state.rounds.set(event.aggregate_id, {
          round_id: event.aggregate_id,
          rule_id: payload.rule_id ?? null,
          name: payload.name ?? null,
          started_at: event.occurred_at,
        });
        break;
      case "EVIDENCE_RECORDED":
        state.deviceMessages.set(event.aggregate_id, { evidence_id: event.aggregate_id, ...payload });
        break;
      case "RESULT_CERTIFIED": {
        const list = state.scores.get(event.aggregate_id) ?? [];
        list.push({
          kind: "certified",
          score_version: payload.score_version,
          entries: payload.entries,
          judge_id: payload.judge_id,
          certified_at: payload.certified_at,
          status: "certified",
        });
        state.scores.set(event.aggregate_id, list);
        break;
      }
      case "REVIEWER_REGISTERED":
        state.reviewers.set(event.aggregate_id, {
          reviewer_id: event.aggregate_id,
          role: payload.role,
          conflicts: payload.conflicts ?? {},
        });
        break;
      case "APPEAL_ACCEPTED":
        this._openCase(event.aggregate_id, payload, null);
        break;
      case "RETRIAL_OPENED":
        this._openCase(event.aggregate_id, payload, payload.retrial_of);
        break;
      case "APPEAL_QUARANTINED":
        state.quarantines.push({ quarantine_id: event.aggregate_id, kind: "appeal", ...payload });
        bumpCounter(state.counters, "quarantine", event.aggregate_id, "quar-");
        break;
      case "EVIDENCE_ATTACHED": {
        const target = state.cases.get(event.aggregate_id);
        if (target) {
          target.evidence.push({
            evidence_ref: payload.evidence_ref,
            source: payload.source,
            collected_at: payload.collected_at,
            payload: payload.payload,
            late: payload.late,
            receipt_no: payload.receipt_no ?? null,
          });
        }
        if (payload.receipt_no) {
          state.receipts.set(payload.receipt_no, {
            content_hash: payload.content_hash,
            evidence_ref: payload.evidence_ref,
            case_id: event.aggregate_id,
          });
        }
        break;
      }
      case "EVIDENCE_QUARANTINED":
        state.quarantines.push({
          quarantine_id: `${event.aggregate_id}#${event.version}`,
          kind: "evidence",
          case_id: event.aggregate_id,
          ...payload,
        });
        break;
      case "DOUBT_RAISED": {
        const target = state.cases.get(event.aggregate_id);
        if (target) {
          target.doubts.push(payload);
          target.doubtKeys.add(contentFingerprint({ check_id: payload.check_id, detail: payload.detail }));
        }
        break;
      }
      case "RECUSAL_SCREENED":
        state.cases.get(event.aggregate_id)?.screenings.push(payload.results);
        break;
      case "REVIEWER_ASSIGNED":
        state.cases.get(event.aggregate_id)?.reviewers.push({ reviewer_id: payload.reviewer_id, role: payload.role });
        break;
      case "RULING_SIGNED":
        state.cases.get(event.aggregate_id)?.signatures.push({
          reviewer_id: payload.reviewer_id,
          role: payload.role,
          decision_type: payload.decision_type,
        });
        break;
      case "RULING_ISSUED": {
        const target = state.cases.get(event.aggregate_id);
        if (target) {
          target.ruling = {
            ruling_id: payload.ruling_id,
            type: payload.type,
            recomputed_entries: payload.recomputed_entries ?? null,
            rationale: payload.rationale ?? null,
            signatures: payload.signatures ?? [],
          };
          target.status = "decided";
        }
        bumpCounter(state.counters, "ruling", payload.ruling_id, "ruling-");
        break;
      }
      case "SCORE_CORRECTED": {
        const list = state.scores.get(event.aggregate_id) ?? [];
        const previous = list.find((item) => item.score_version === payload.corrects_version);
        if (previous) previous.status = payload.annulled ? "annulled" : "superseded";
        list.push({
          kind: "correction",
          score_version: payload.score_version,
          corrects_version: payload.corrects_version,
          ruling_id: payload.ruling_id,
          entries: payload.entries ?? null,
          annulled: payload.annulled === true,
          status: "effective",
        });
        state.scores.set(event.aggregate_id, list);
        break;
      }
      case "RETRIAL_SUGGESTED": {
        const target = state.cases.get(event.aggregate_id);
        if (target) {
          target.suggestions.push({
            suggestion_id: payload.suggestion_id,
            trigger_evidence: payload.trigger_evidence,
            reason: payload.reason,
          });
        }
        bumpCounter(state.counters, "suggestion", payload.suggestion_id, "sug-");
        break;
      }
      case "RANKING_PUBLISHED":
        state.rankings.set(event.aggregate_id, payload);
        bumpCounter(state.counters, "publication", event.aggregate_id, "pub-");
        break;
      case "APPEAL_WINDOW_CLOSED": {
        const target = state.cases.get(event.aggregate_id);
        if (target) target.window_closed = true;
        break;
      }
      default:
        break; // 约定内但本服务不消费的事件（如 RULING_AMENDED）原样保留
    }
  }

  _openCase(case_id, payload, retrial_of) {
    const state = this._state;
    const opened = {
      case_id,
      appeal_no: payload.appeal_no,
      fingerprint: payload.fingerprint,
      appellant: payload.appellant,
      round_id: payload.round_id,
      score_version: payload.score_version,
      rule_id: payload.rule_id ?? null,
      rule_version: payload.rule_version ?? null,
      appeal_deadline: payload.appeal_deadline,
      grounds: payload.grounds ?? null,
      status: "open",
      retrial_of: retrial_of ?? null,
      suggestions: [],
      evidence: [],
      doubts: [],
      doubtKeys: new Set(),
      reviewers: [],
      screenings: [],
      signatures: [],
      ruling: null,
      window_closed: false,
    };
    for (const item of payload.carried_evidence ?? []) {
      opened.evidence.push({ ...item, late: false });
    }
    state.cases.set(case_id, opened);
    state.fingerprintIndex.set(payload.fingerprint, case_id);
    if (!retrial_of && !state.appealIndex.has(payload.appeal_no)) {
      state.appealIndex.set(payload.appeal_no, case_id);
    }
    bumpCounter(state.counters, "case", case_id, "case-");
  }

  /** 自动规则比对：只提出疑点（DOUBT_RAISED），不对案件下任何结论。 */
  async _compareWithRule(case_id) {
    const state = this._mustCase(case_id);
    const rule = (this._state.rules.get(state.rule_id) ?? [])
      .find((item) => item.rule_version === state.rule_version);
    if (!rule) return [];
    const messages = state.evidence
      .filter((item) => item.source === "device" && !item.late)
      .flatMap((item) => this._resolveDeviceMessages(item));

    const raised = [];
    for (const check of rule.device_checks ?? []) {
      if (check.check_id === "value_range") {
        const { min, max } = check.params ?? {};
        for (const message of messages) {
          if ((min !== undefined && message.value < min) || (max !== undefined && message.value > max)) {
            raised.push({
              check_id: check.check_id,
              detail: `设备 ${message.device_id} 第 ${message.seq} 条读数 ${message.value} 超出区间 [${min}, ${max}]`,
            });
          }
        }
      }
      if (check.check_id === "seq_continuous") {
        const byDevice = new Map();
        for (const message of messages) {
          if (!byDevice.has(message.device_id)) byDevice.set(message.device_id, []);
          byDevice.get(message.device_id).push(message.seq);
        }
        for (const [device_id, seqs] of byDevice) {
          const sorted = [...seqs].sort((a, b) => a - b);
          for (let i = 1; i < sorted.length; i += 1) {
            if (sorted[i] - sorted[i - 1] > 1) {
              raised.push({
                check_id: check.check_id,
                detail: `设备 ${device_id} 消息序号在 ${sorted[i - 1]} 与 ${sorted[i]} 之间存在缺口`,
              });
            }
          }
        }
      }
    }

    const fresh = [];
    for (const doubt of raised) {
      const key = contentFingerprint(doubt);
      if (state.doubtKeys.has(key)) continue;
      await this._append("appeal_case", case_id, "DOUBT_RAISED", doubt, `规则比对疑点：${doubt.detail}`);
      fresh.push(doubt);
    }
    return fresh;
  }

  _resolveDeviceMessages(evidence) {
    if (Array.isArray(evidence.payload?.messages)) return evidence.payload.messages;
    if (Array.isArray(evidence.payload?.evidence_ids)) {
      return evidence.payload.evidence_ids
        .map((id) => this._state.deviceMessages.get(id))
        .filter(Boolean);
    }
    return [];
  }

  _armDeadline(case_id) {
    const state = this._state.cases.get(case_id);
    if (!state || state.status !== "open" || state.window_closed) return;
    const delay = Math.max(0, new Date(state.appeal_deadline).getTime() - this._clock().getTime());
    const handle = this._timers.setTimeout(() => {
      this._handles.delete(handle);
      this._execute(() => this._enforceDeadline(case_id)).catch(() => {});
    }, delay);
    this._handles.add(handle);
  }

  async _enforceDeadline(case_id) {
    const state = this._state.cases.get(case_id);
    if (!state || state.status !== "open" || state.window_closed) return;
    if (this._clock().getTime() < new Date(state.appeal_deadline).getTime()) return;
    await this._append("appeal_case", case_id, "APPEAL_WINDOW_CLOSED", {
      appeal_deadline: state.appeal_deadline,
    }, `案件 ${case_id} 申诉时限已到，证据窗口关闭`);
  }

  _ruleInEffect(rule_id, atIso) {
    const versions = this._state.rules.get(rule_id) ?? [];
    const at = new Date(atIso).getTime();
    let best = null;
    for (const version of versions) {
      const from = new Date(version.effective_from).getTime();
      if (from <= at && (!best || from > new Date(best.effective_from).getTime())) best = version;
    }
    return best;
  }

  _mustRound(round_id) {
    const round = this._state.rounds.get(round_id);
    if (!round) throw new DisputeError("UNKNOWN_ROUND", `未知赛段：${round_id}`);
    return round;
  }

  _mustCase(case_id) {
    const state = this._state.cases.get(case_id);
    if (!state) throw new DisputeError("UNKNOWN_CASE", `未知案件：${case_id}`);
    return state;
  }

  _mustOpenCase(case_id) {
    const state = this._mustCase(case_id);
    if (state.status !== "open") throw new DisputeError("CASE_NOT_OPEN", `案件 ${case_id} 不在复核中`);
    return state;
  }

  _scoreOf(round_id, score_version) {
    return (this._state.scores.get(round_id) ?? []).find((item) => item.score_version === score_version) ?? null;
  }

  _nextScoreVersion(round_id) {
    return (this._state.scores.get(round_id) ?? []).length + 1;
  }
}
