import { createHash } from "node:crypto";

/** 生成规范化 JSON 字符串：对象键名递归排序，确保同一内容得到同一串。 */
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 按内容计算提交物指纹，用于识别重复申诉与离线证据回执。 */
export function contentFingerprint(content) {
  return createHash("sha256").update(canonicalize(content)).digest("hex");
}
