import { createHash } from "node:crypto";

/**
 * 生成内容指纹：对键序无关的稳定序列化取 SHA-256。
 * 重复申诉与离线证据回执均按内容识别，而不是按编号识别。
 */
export function contentFingerprint(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
