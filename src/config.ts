import { z } from "zod";

export const DEFAULT_CONFIG = Object.freeze({
  alias: "opencode",
  sendMethod: "private-api" as const,
  remoteAgent: "bluebubbles-remote",
  pinExpiryMinutes: 15,
  pinAttempts: 5,
  permissionExpiryMinutes: 15,
  responseChunkCharacters: 3_000,
  catchupPageSize: 100,
  maxConcurrentSessions: 4,
  allowedTools: [] as string[],
  thinkingReaction: "emphasize" as const,
  typingIndicator: true,
  toolCallMessages: false,
  personalityTokens: {} as Record<string, { value: number; description: string }>,
  permissionWaitMessage: "Hang on, an administrator needs to approve that.",
});

export const tapbackSchema = z.enum(["love", "like", "dislike", "laugh", "emphasize", "question"]);

const secureServerUrl = z.string().trim().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.username || url.password) {
    context.addIssue({ code: "custom", message: "serverUrl must not contain credentials" });
  }

  for (const key of url.searchParams.keys()) {
    if (["password", "token", "guid"].includes(key.toLowerCase())) {
      context.addIssue({ code: "custom", message: "serverUrl must not contain credentials" });
      break;
    }
  }

  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol === "http:" && loopbackHosts.has(url.hostname)) return;
  if (url.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "serverUrl must use HTTPS unless its host is an exact loopback host",
    });
  }
});

const positiveInteger = z.number().int().positive();
const permanentlyDeniedToolNames = new Set([
  "bash",
  "shell",
  "task",
  "skill",
  "question",
  "todowrite",
  "doom_loop",
  "external_directory",
  "share",
]);
const allowedTool = z.string().trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "allowedTools entries must be exact tool names")
  .refine(
    (name) => !permanentlyDeniedToolNames.has(name) && !name.startsWith("bluebubbles_"),
    "allowedTools cannot enable permanently denied tools",
  );
const personalityTokenSchema = z.object({
  value: z.number().int().min(0).max(100),
  description: z.string().trim().min(1).max(1_000),
}).strict();

export const blueBubblesOptionsSchema = z.object({
  serverUrl: secureServerUrl,
  passwordEnv: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "passwordEnv must name an environment variable"),
  instanceId: z.string().trim().min(1, "instanceId must not be empty"),
  stateDirectory: z.string().trim().min(1).optional(),
  sessionDirectory: z.string().trim().min(1).optional(),
  administratorHandle: z.string().trim().min(1).optional(),
  alias: z.string().trim().min(1).regex(/^[^@\s]+$/, "alias must not contain @ or whitespace").default(DEFAULT_CONFIG.alias),
  sendMethod: z.enum(["private-api", "apple-script"]).default(DEFAULT_CONFIG.sendMethod),
  remoteAgent: z.string().trim().min(1).default(DEFAULT_CONFIG.remoteAgent),
  model: z.string().trim().regex(/^[^/\s]+\/[^\s]+$/, "model must use provider/model format").optional(),
  pinExpiryMinutes: positiveInteger.default(DEFAULT_CONFIG.pinExpiryMinutes),
  pinAttempts: positiveInteger.default(DEFAULT_CONFIG.pinAttempts),
  permissionExpiryMinutes: positiveInteger.default(DEFAULT_CONFIG.permissionExpiryMinutes),
  responseChunkCharacters: positiveInteger.default(DEFAULT_CONFIG.responseChunkCharacters),
  catchupPageSize: positiveInteger.max(1_000).default(DEFAULT_CONFIG.catchupPageSize),
  maxConcurrentSessions: positiveInteger.default(DEFAULT_CONFIG.maxConcurrentSessions),
  allowedTools: z.array(allowedTool).max(100).refine(
    (tools) => new Set(tools).size === tools.length,
    "allowedTools entries must be unique",
  ).default(DEFAULT_CONFIG.allowedTools),
  thinkingReaction: z.union([tapbackSchema, z.literal(false)]).default(DEFAULT_CONFIG.thinkingReaction),
  typingIndicator: z.boolean().default(DEFAULT_CONFIG.typingIndicator),
  toolCallMessages: z.boolean().default(DEFAULT_CONFIG.toolCallMessages),
  personalityTokens: z.record(
    z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "personality token names must be lowercase snake_case"),
    personalityTokenSchema,
  ).default(DEFAULT_CONFIG.personalityTokens),
  permissionWaitMessage: z.union([
    z.string().trim().min(1).max(1_000),
    z.literal(false),
  ]).default(DEFAULT_CONFIG.permissionWaitMessage),
}).strict();

export type BlueBubblesOptions = z.input<typeof blueBubblesOptionsSchema>;
export type ValidatedBlueBubblesOptions = z.output<typeof blueBubblesOptionsSchema>;
export type BlueBubblesConfig = ValidatedBlueBubblesOptions & { password: string };

export function parseOptions(options: unknown): ValidatedBlueBubblesOptions {
  return blueBubblesOptionsSchema.parse(options);
}

export function loadConfig(
  options: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BlueBubblesConfig {
  const parsed = parseOptions(options);
  const password = environment[parsed.passwordEnv];
  if (password === undefined || password.length === 0) {
    throw new Error(`Required password environment variable ${parsed.passwordEnv} is not set`);
  }
  return { ...parsed, password };
}
