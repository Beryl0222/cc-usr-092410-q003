import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 事件存储接口：append 追加一条事件，loadAll 按追加顺序读出全部事件。
 * 事件一经写入不得改写，更正只能通过追加新的后继事件表达。
 */

/** 内存实现，用于单元测试与本地联调。 */
export class InMemoryEventStore {
  constructor(events = []) {
    this._events = events.map((event) => structuredClone(event));
  }

  async append(event) {
    this._events.push(structuredClone(event));
  }

  async loadAll() {
    return this._events.map((event) => structuredClone(event));
  }
}

/** 文件实现（JSONL，每行一条事件），用于验证重启后状态与截止任务的恢复。 */
export class FileEventStore {
  constructor(path) {
    this.path = path;
  }

  async append(event) {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }

  async loadAll() {
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return [];
      throw err;
    }
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
}
