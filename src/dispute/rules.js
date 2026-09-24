/**
 * 自动规则比对：对照受理时冻结的规则版本检查案件证据，
 * 只提出疑点供复核人员参考，不自行得出裁决结论。
 */

function byCollectedAt(left, right) {
  return String(left.collected_at).localeCompare(String(right.collected_at));
}

export function evaluateExpectations(expectations, evidence) {
  const doubts = [];
  for (const expectation of expectations ?? []) {
    if (expectation.kind === "required_source") {
      if (!evidence.some((item) => item.source === expectation.source)) {
        doubts.push({ kind: expectation.kind, source: expectation.source, doubt: expectation.doubt });
      }
      continue;
    }
    if (expectation.kind === "device_seq_strict") {
      const messages = evidence
        .filter((item) => item.source === expectation.source)
        .slice()
        .sort(byCollectedAt);
      for (let index = 1; index < messages.length; index += 1) {
        const previous = messages[index - 1].details?.seq;
        const current = messages[index].details?.seq;
        if (typeof previous === "number" && typeof current === "number" && current <= previous) {
          doubts.push({
            kind: expectation.kind,
            source: expectation.source,
            doubt: expectation.doubt,
            evidence: [messages[index - 1].evidence_id, messages[index].evidence_id],
          });
        }
      }
      continue;
    }
    if (expectation.kind === "value_range") {
      for (const item of evidence) {
        if (expectation.source && item.source !== expectation.source) continue;
        const value = item.details?.[expectation.field];
        if (typeof value !== "number") continue;
        if (value < expectation.min || value > expectation.max) {
          doubts.push({
            kind: expectation.kind,
            source: item.source,
            doubt: expectation.doubt,
            evidence: [item.evidence_id],
            value,
          });
        }
      }
      continue;
    }
    throw new Error(`未知的规则比对类型：${expectation.kind}`);
  }
  return doubts;
}
