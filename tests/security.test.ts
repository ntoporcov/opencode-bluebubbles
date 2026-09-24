import { describe, expect, test } from "bun:test";
import {
  generatePin,
  generateReviewCode,
  hashSecret,
  hashSecretAsync,
  maskIdentifier,
  normalizeSenderHandle,
  redactSensitive,
  relationshipKey,
  safeError,
  verifySecret,
  verifySecretAsync,
} from "../src/security";

describe("security utilities", () => {
  test("generates fixed-format random control codes", () => {
    expect(generatePin()).toMatch(/^\d{8}$/);
    expect(generateReviewCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  });

  test("salts scrypt hashes and verifies them", async () => {
    const first = hashSecret("12345678");
    const second = hashSecret("12345678");
    expect(first).not.toBe(second);
    expect(verifySecret("12345678", first)).toBe(true);
    expect(verifySecret("12345679", first)).toBe(false);
    expect(verifySecret("12345678", "malformed")).toBe(false);

    const asynchronous = await hashSecretAsync("K7M4");
    expect(await verifySecretAsync("K7M4", asynchronous)).toBe(true);
    expect(await verifySecretAsync("K7M5", asynchronous)).toBe(false);
  });

  test("normalizes without guessing a phone country", () => {
    expect(normalizeSenderHandle(" User@Example.COM ")).toBe("user@example.com");
    expect(normalizeSenderHandle(" (415) 555-0100 ")).toBe("(415) 555-0100");
    expect(normalizeSenderHandle("+14155550100")).toBe("+14155550100");
  });

  test("isolates relationship keys and masks identifiers", () => {
    const key = relationshipKey("one", "chat", "USER@example.com");
    expect(key).toBe(relationshipKey("one", "chat", "user@example.com"));
    expect(key).not.toBe(relationshipKey("two", "chat", "user@example.com"));
    expect(key).not.toBe(relationshipKey("one", "other", "user@example.com"));
    expect(maskIdentifier("user@example.com")).not.toContain("user@example.com");
    expect(maskIdentifier("+14155550100")).toBe("***00");
  });

  test("redacts credential URLs, explicit secrets, and safe errors", () => {
    const text = redactSensitive("GET https://example.com/api?password=hunter2 token=hunter2", ["hunter2"]);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("?password=");
    expect(safeError(new Error("failed https://u:p@example.com/x?guid=secret"))).not.toContain("secret");
  });
});
