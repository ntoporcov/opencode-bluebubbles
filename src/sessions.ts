export type ApiResult<T> = {
  data?: T;
  error?: unknown;
};

export function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b|session.*(?:missing|not found)|not found.*session/iu.test(message);
}

export type MessagePart = {
  type: string;
  text?: string;
  ignored?: boolean;
};

export type MessageEnvelope = {
  info: {
    role: string;
  };
  parts: readonly MessagePart[];
};

type Session = { id: string };
type PromptResponse = MessageEnvelope;

export interface OpenCodeClient {
  session: {
    create(options: { body: { title: string }; query?: { directory: string } }): Promise<ApiResult<Session>>;
    prompt(options: {
      path: { id: string };
      query?: { directory: string };
      body: {
        agent?: string;
        noReply?: boolean;
        parts: Array<{ type: "text"; text: string }>;
      };
    }): Promise<ApiResult<PromptResponse>>;
    messages(options: { path: { id: string }; query?: { directory: string } }): Promise<ApiResult<MessageEnvelope[]>>;
  };
  tui: {
    showToast(options: {
      body: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
      };
    }): Promise<ApiResult<boolean>>;
  };
  app: {
    log(options: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
        extra?: Record<string, unknown>;
      };
    }): Promise<ApiResult<boolean>>;
  };
  postSessionIdPermissionsPermissionId(options: {
    path: { id: string; permissionID: string };
    body: { response: "once" | "reject" };
  }): Promise<ApiResult<boolean>>;
}

type QueuedTask = {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export class KeyedConcurrencyQueue {
  readonly #limit: number;
  readonly #queues = new Map<string, QueuedTask[]>();
  readonly #readyKeys: string[] = [];
  readonly #activeKeys = new Set<string>();
  #activeCount = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("concurrency limit must be a positive integer");
    }
    this.#limit = limit;
  }

  get activeCount(): number {
    return this.#activeCount;
  }

  get keyCount(): number {
    return this.#queues.size;
  }

  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    if (!key) return Promise.reject(new Error("queue key must not be empty"));

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedTask = {
        run: async () => task(),
        resolve: (value) => resolve(value as T),
        reject,
      };
      const queue = this.#queues.get(key);
      if (queue) {
        queue.push(queued);
      } else {
        this.#queues.set(key, [queued]);
        this.#readyKeys.push(key);
      }
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#activeCount < this.#limit) {
      const key = this.#readyKeys.shift();
      if (key === undefined) return;
      if (this.#activeKeys.has(key)) continue;

      const queue = this.#queues.get(key);
      const task = queue?.shift();
      if (!queue || !task) {
        this.#queues.delete(key);
        continue;
      }

      this.#activeKeys.add(key);
      this.#activeCount += 1;
      void task.run().then(
        (value) => {
          this.#finish(key, queue);
          task.resolve(value);
        },
        (reason) => {
          this.#finish(key, queue);
          task.reject(reason);
        },
      );
    }
  }

  #finish(key: string, queue: QueuedTask[]): void {
    this.#activeCount -= 1;
    this.#activeKeys.delete(key);
    if (queue.length > 0) this.#readyKeys.push(key);
    else this.#queues.delete(key);
    this.#drain();
  }
}

export function extractAssistantText(message: MessageEnvelope): string {
  if (message.info.role !== "assistant") return "";
  return message.parts
    .filter((part) => part.type === "text" && part.ignored !== true && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

export type Toast = {
  title?: string;
  message: string;
  variant?: "info" | "success" | "warning" | "error";
  duration?: number;
};

export type LogEntry = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  extra?: Record<string, unknown>;
};

export type RemotePrompt = {
  relationshipKey: string;
  sessionID: string;
  text: string;
  agent?: string;
};

export class OpenCodeAdapter {
  readonly #client: OpenCodeClient;
  readonly #service: string;
  readonly #directory: string | undefined;
  readonly #prompts: KeyedConcurrencyQueue;

  constructor(client: OpenCodeClient, options: { service?: string; maxConcurrentPrompts?: number; directory?: string } = {}) {
    this.#client = client;
    this.#service = options.service ?? "opencode-bluebubbles";
    this.#directory = options.directory;
    this.#prompts = new KeyedConcurrencyQueue(options.maxConcurrentPrompts ?? 4);
  }

  async createTitledSession(title: string): Promise<string> {
    const result = await this.#call("create session", () => this.#client.session.create({
      body: { title },
      ...(this.#directory === undefined ? {} : { query: { directory: this.#directory } }),
    }));
    if (!result.data?.id) throw new Error("OpenCode create session failed");
    return result.data.id;
  }

  async insertNoReplyText(sessionID: string, text: string, agent?: string): Promise<void> {
    const body: {
      noReply: true;
      agent?: string;
      parts: Array<{ type: "text"; text: string }>;
    } = { noReply: true, parts: [{ type: "text", text }] };
    if (agent !== undefined) body.agent = agent;
    await this.#call("insert session text", () => this.#client.session.prompt({
      path: { id: sessionID },
      ...(this.#directory === undefined ? {} : { query: { directory: this.#directory } }),
      body,
    }));
  }

  async promptReviewQuestion(sessionID: string, text: string, agent: string): Promise<void> {
    await this.#call("prompt permission review", () => this.#client.session.prompt({
      path: { id: sessionID },
      ...(this.#directory === undefined ? {} : { query: { directory: this.#directory } }),
      body: { agent, parts: [{ type: "text", text }] },
    }));
  }

  promptRemoteAgent(input: RemotePrompt): Promise<string> {
    return this.#prompts.run(input.relationshipKey, async () => {
      const result = await this.#call("prompt remote agent", () => this.#client.session.prompt({
        path: { id: input.sessionID },
        ...(this.#directory === undefined ? {} : { query: { directory: this.#directory } }),
        body: {
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          parts: [{ type: "text", text: input.text }],
        },
      }));
      if (!result.data) throw new Error("OpenCode prompt remote agent failed");
      return extractAssistantText(result.data);
    });
  }

  async showToast(toast: Toast): Promise<void> {
    const body: {
      title?: string;
      message: string;
      variant: "info" | "success" | "warning" | "error";
      duration?: number;
    } = {
      message: toast.message,
      variant: toast.variant ?? "info",
    };
    if (toast.title !== undefined) body.title = toast.title;
    if (toast.duration !== undefined) body.duration = toast.duration;
    await this.#call("show toast", () => this.#client.tui.showToast({ body }));
  }

  async log(entry: LogEntry): Promise<void> {
    const body: {
      service: string;
      level: LogEntry["level"];
      message: string;
      extra?: Record<string, unknown>;
    } = { service: this.#service, level: entry.level, message: entry.message };
    if (entry.extra !== undefined) body.extra = entry.extra;
    await this.#call("write app log", () => this.#client.app.log({ body }));
  }

  async latestUserText(sessionID: string): Promise<string | undefined> {
    const result = await this.#call("list session messages", () => this.#client.session.messages({
      path: { id: sessionID },
      ...(this.#directory === undefined ? {} : { query: { directory: this.#directory } }),
    }));
    if (!result.data) throw new Error("OpenCode list session messages failed");

    for (let index = result.data.length - 1; index >= 0; index -= 1) {
      const message = result.data[index];
      if (message?.info.role !== "user") continue;
      return message.parts
        .filter((part) => part.type === "text" && part.ignored !== true && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
    }
    return undefined;
  }

  async replyPermission(sessionID: string, permissionID: string, response: "once" | "reject"): Promise<void> {
    if (response !== "once" && response !== "reject") {
      throw new Error("permission response must be once or reject");
    }
    await this.#call("reply to permission", () => this.#client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID },
      body: { response },
    }));
  }

  async #call<T>(operation: string, call: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try {
      const result = await call();
      if (result.error !== undefined) throw new Error(`OpenCode ${operation} failed: ${this.#errorStatus(result.error)}`);
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`OpenCode ${operation} failed`)) throw error;
      throw new Error(`OpenCode ${operation} failed: ${this.#errorStatus(error)}`);
    }
  }

  #errorStatus(error: unknown): string {
    if (typeof error === "object" && error !== null) {
      const value = error as Record<string, unknown>;
      if (typeof value.status === "number") return String(value.status);
      if (value.name === "NotFoundError" || value._tag === "SessionNotFoundError") return "404";
      if (typeof value.message === "string" && /\b404\b/u.test(value.message)) return "404";
      const response = value.response;
      if (typeof response === "object" && response !== null && typeof (response as Record<string, unknown>).status === "number") {
        return String((response as Record<string, unknown>).status);
      }
      const cause = value.cause;
      if (typeof cause === "object" && cause !== null && typeof (cause as Record<string, unknown>).status === "number") {
        return String((cause as Record<string, unknown>).status);
      }
      try {
        if (/\b404\b/u.test(JSON.stringify(error))) return "404";
      } catch {
        // Error serialization is diagnostic-only and must not change control flow.
      }
    }
    return error instanceof Error && /\b404\b/u.test(error.message) ? "404" : "unknown";
  }
}
