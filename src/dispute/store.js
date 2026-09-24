import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { validateEvent } from "../validator.js";

function emptyState() {
  return { events: [], tasks: [], directories: { reviewers: {} } };
}

function normalizeState(state) {
  return {
    events: Array.isArray(state?.events) ? state.events : [],
    tasks: Array.isArray(state?.tasks) ? state.tasks : [],
    directories: { reviewers: {}, ...(state?.directories ?? {}) },
  };
}

/**
 * 追加式事件存储：记录一经写入，标识、发生时间与版本不得原地改写，
 * 更正只能通过追加新的后继记录完成。
 */
export class EventStore {
  constructor(state) {
    this.state = normalizeState(state);
  }

  get events() {
    return this.state.events;
  }

  get tasks() {
    return this.state.tasks;
  }

  get directories() {
    return this.state.directories;
  }

  append(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) {
      throw new Error(`事件不符合领域约定：${errors.join("；")}`);
    }
    if (this.state.events.some((item) => item.event_id === event.event_id)) {
      throw new Error(`事件标识重复：${event.event_id}`);
    }
    this.state.events.push(event);
    this.persist();
    return event;
  }

  /** 登记截止任务；任务带原始到期时间，重启后按原时间继续。 */
  scheduleTask(task) {
    if (this.state.tasks.some((item) => item.task_id === task.task_id)) return;
    this.state.tasks.push(task);
    this.persist();
  }

  persist() {}
}

/** 以 JSON 文件持久化的存储，服务重启后从文件恢复事件与截止任务。 */
export class JsonFileStore extends EventStore {
  constructor(path) {
    super(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);
    this.path = path;
    this.persist();
  }

  persist() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
