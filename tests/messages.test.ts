import { describe, expect, test } from "bun:test";
import { chunkMessage, classifyMessage, parseAliasMessage, parsePinCommand, routeRelationship } from "../src/messages";

const direct = {
  guid: "message-1",
  text: "hello",
  dateCreated: 123,
  isFromMe: false,
  handle: { address: "USER@example.com", service: "iMessage" },
  chats: [{ guid: "iMessage;-;chat", style: 45 }],
};

describe("message validation and routing", () => {
  test("classifies one direct chat and rejects malformed input", () => {
    const result = classifyMessage(direct);
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.message.chatKind).toBe("direct");
      expect(result.message.senderHandle).toBe("user@example.com");
    }
    expect(classifyMessage({ ...direct, surprise: true }).kind).toBe("message");
    expect(classifyMessage({ ...direct, chats: [...direct.chats, ...direct.chats] })).toEqual({ kind: "ignored", reason: "ambiguous-chat" });
  });

  test("ignores outgoing, system, service, reaction, edit, and attachment-only messages", () => {
    expect(classifyMessage({ ...direct, isFromMe: true, handle: null }).kind).toBe("ignored");
    expect(classifyMessage({ ...direct, itemType: 1 }).kind).toBe("ignored");
    expect(classifyMessage({ ...direct, balloonBundleId: "com.apple.messages" }).kind).toBe("ignored");
    expect(classifyMessage({ ...direct, associatedMessageGuid: "p:0/original" }).kind).toBe("ignored");
    expect(classifyMessage({ ...direct, dateEdited: 456 }).kind).toBe("ignored");
    expect(classifyMessage({ ...direct, text: null, attachments: [{ guid: "a" }] }).kind).toBe("ignored");
  });

  test("parses aliases only at the start with case-insensitive boundaries", () => {
    expect(parseAliasMessage("@OpenCode explain this", "opencode")).toBe("explain this");
    expect(parseAliasMessage(" @opencode no", "opencode")).toBeUndefined();
    expect(parseAliasMessage("@opencoder no", "opencode")).toBeUndefined();
    expect(parseAliasMessage("@a.b yes", "a.b")).toBe("yes");
  });

  test("accepts only anchored eight-digit PIN commands", () => {
    expect(parsePinCommand("PIN 12345678")).toBe("12345678");
    expect(parsePinCommand("pin 12345678")).toBe("12345678");
    expect(parsePinCommand("PIN 12345678 extra")).toBeUndefined();
    expect(parsePinCommand(" PIN 12345678")).toBeUndefined();
  });

  test("requires aliases for groups and creates exact relationship routing input", () => {
    const classified = classifyMessage({ ...direct, text: "@opencode PIN 12345678", chats: [{ guid: "group", style: 43 }] });
    expect(classified.kind).toBe("message");
    if (classified.kind !== "message") return;
    expect(routeRelationship({ instanceId: "server", alias: "opencode", message: classified.message })).toEqual({
      relationshipKeyInput: { instanceId: "server", chatGuid: "group", senderHandle: "user@example.com" },
      chatKind: "group",
      request: "PIN 12345678",
      pin: "12345678",
    });
    expect(routeRelationship({ instanceId: "server", alias: "other", message: classified.message })).toBeUndefined();
  });

  test("chunks by Unicode code point without empty chunks", () => {
    expect(chunkMessage("A😀BC", 2)).toEqual(["A😀", "BC"]);
    expect(chunkMessage("", 2)).toEqual([]);
    expect(() => chunkMessage("x", 0)).toThrow();
  });
});
