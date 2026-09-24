import { z } from "zod";
import { normalizeSenderHandle } from "./security";

const handleSchema = z.object({
  address: z.string(),
  service: z.string().optional(),
}).passthrough();

const chatSchema = z.object({
  guid: z.string(),
  style: z.number().int(),
  displayName: z.string().optional(),
  participants: z.array(z.object({ address: z.string() }).strict()).optional(),
}).passthrough();

const attachmentSchema = z.object({ guid: z.string().optional() }).passthrough();

export const blueBubblesMessageSchema = z.object({
  guid: z.string().min(1),
  text: z.string().nullable(),
  dateCreated: z.number().nullable(),
  isFromMe: z.boolean(),
  handle: handleSchema.nullable(),
  chats: z.array(chatSchema).optional(),
  attachments: z.array(attachmentSchema).optional(),
  itemType: z.number().int().nullable().optional(),
  groupActionType: z.number().int().nullable().optional(),
  associatedMessageType: z.union([z.number().int(), z.string()]).nullable().optional(),
  associatedMessageGuid: z.string().nullable().optional(),
  balloonBundleId: z.string().nullable().optional(),
  isSystemMessage: z.boolean().optional(),
  isServiceMessage: z.boolean().optional(),
  isReaction: z.boolean().optional(),
  isEdited: z.boolean().optional(),
  dateEdited: z.number().nullable().optional(),
}).passthrough();

export type BlueBubblesMessage = z.infer<typeof blueBubblesMessageSchema>;
export type ChatKind = "direct" | "group";

export type ClassifiedMessage = {
  messageGuid: string;
  dateCreated: number | null;
  chatGuid: string;
  chatKind: ChatKind;
  chatDisplayName?: string;
  senderHandle: string;
  text: string;
};

export type MessageClassification =
  | { kind: "message"; message: ClassifiedMessage }
  | { kind: "ignored"; reason: "outgoing" | "system" | "service" | "reaction" | "edit" | "attachment-only" | "missing-sender" | "ambiguous-chat" | "unsupported-chat-style" }
  | { kind: "invalid"; error: z.ZodError };

export function classifyMessage(input: unknown): MessageClassification {
  const parsed = blueBubblesMessageSchema.safeParse(input);
  if (!parsed.success) return { kind: "invalid", error: parsed.error };
  const message = parsed.data;
  if (message.isFromMe) return { kind: "ignored", reason: "outgoing" };
  if (message.isSystemMessage || (message.itemType ?? 0) !== 0 || (message.groupActionType ?? 0) !== 0) {
    return { kind: "ignored", reason: "system" };
  }
  if (message.isServiceMessage || message.balloonBundleId) return { kind: "ignored", reason: "service" };
  if (message.isReaction || (message.associatedMessageType ?? 0) !== 0 || message.associatedMessageGuid) {
    return { kind: "ignored", reason: "reaction" };
  }
  if (message.isEdited || message.dateEdited != null) return { kind: "ignored", reason: "edit" };
  if (message.text == null || message.text.trim().length === 0) {
    return { kind: "ignored", reason: "attachment-only" };
  }
  if (!message.handle?.address.trim()) return { kind: "ignored", reason: "missing-sender" };
  if (message.chats?.length !== 1) return { kind: "ignored", reason: "ambiguous-chat" };

  const chat = message.chats[0];
  if (!chat) return { kind: "ignored", reason: "ambiguous-chat" };
  const chatKind = chat.style === 45 ? "direct" : chat.style === 43 ? "group" : undefined;
  if (!chatKind) return { kind: "ignored", reason: "unsupported-chat-style" };

  const classified: ClassifiedMessage = {
    messageGuid: message.guid,
    dateCreated: message.dateCreated,
    chatGuid: chat.guid,
    chatKind,
    senderHandle: normalizeSenderHandle(message.handle.address),
    text: message.text,
  };
  if (chat.displayName !== undefined) classified.chatDisplayName = chat.displayName;
  return { kind: "message", message: classified };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function parseAliasMessage(text: string, alias: string): string | undefined {
  const normalizedAlias = alias.trim().replace(/^@/u, "");
  if (!normalizedAlias) throw new Error("alias must not be empty");
  const match = new RegExp(`^@${escapeRegExp(normalizedAlias)}(?:\\s+|$)([\\s\\S]*)$`, "iu").exec(text);
  const request = match?.[1]?.trim();
  return request ? request : undefined;
}

export function parsePinCommand(text: string): string | undefined {
  return /^PIN\s+([0-9]{8})$/iu.exec(text)?.[1];
}

export type RelationshipRoutingInput = {
  instanceId: string;
  alias: string;
  message: ClassifiedMessage;
};

export type RelationshipRoute = {
  relationshipKeyInput: {
    instanceId: string;
    chatGuid: string;
    senderHandle: string;
  };
  chatKind: ChatKind;
  request: string;
  pin?: string;
};

export function routeRelationship(input: RelationshipRoutingInput): RelationshipRoute | undefined {
  const request = input.message.chatKind === "group"
    ? parseAliasMessage(input.message.text, input.alias)
    : input.message.text.trim();
  if (!request) return undefined;
  const pin = parsePinCommand(request);
  const route: RelationshipRoute = {
    relationshipKeyInput: {
      instanceId: input.instanceId,
      chatGuid: input.message.chatGuid,
      senderHandle: input.message.senderHandle,
    },
    chatKind: input.message.chatKind,
    request,
  };
  if (pin !== undefined) route.pin = pin;
  return route;
}

export function chunkMessage(text: string, maximumCharacters: number): string[] {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters <= 0) {
    throw new RangeError("maximumCharacters must be a positive integer");
  }
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += maximumCharacters) {
    const chunk = characters.slice(index, index + maximumCharacters).join("");
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}
