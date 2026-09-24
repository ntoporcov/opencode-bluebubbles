import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, loadConfig, parseOptions } from "../src/config";

const required = {
  serverUrl: "http://127.0.0.1:1234",
  passwordEnv: "BLUEBUBBLES_PASSWORD",
  instanceId: "home-mac",
};

describe("configuration", () => {
  test("applies documented defaults and loads the password only from the environment", () => {
    expect(loadConfig(required, { BLUEBUBBLES_PASSWORD: "secret" })).toEqual({
      ...required,
      ...DEFAULT_CONFIG,
      password: "secret",
    });
  });

  test("is strict and requires an explicit nonempty instance ID", () => {
    expect(() => parseOptions({ ...required, password: "secret" })).toThrow();
    expect(() => parseOptions({ ...required, instanceId: " " })).toThrow();
    expect(() => loadConfig(required, {})).toThrow();
  });

  test("rejects URL credentials and non-loopback plaintext HTTP", () => {
    for (const serverUrl of [
      "http://example.com",
      "http://localhost.example.com",
      "http://user:pass@localhost:1234",
      "https://example.com/?password=secret",
    ]) {
      expect(() => parseOptions({ ...required, serverUrl })).toThrow();
    }
  });

  test("allows only exact plaintext loopback hosts and HTTPS elsewhere", () => {
    for (const serverUrl of ["http://localhost:1234", "http://127.0.0.1", "http://[::1]:1234", "https://example.com"]) {
      expect(parseOptions({ ...required, serverUrl }).serverUrl).toBe(serverUrl);
    }
  });

  test("rejects catch-up pages larger than BlueBubbles supports", () => {
    expect(() => parseOptions({ ...required, catchupPageSize: 1_001 })).toThrow();
    expect(parseOptions({ ...required, catchupPageSize: 1_000 }).catchupPageSize).toBe(1_000);
  });

  test("validates proactive status configuration", () => {
    expect(parseOptions({
      ...required,
      thinkingReaction: false,
      typingIndicator: false,
      toolCallMessages: true,
      permissionWaitMessage: "Hang on, you have to ask Nic for that",
    })).toMatchObject({
      thinkingReaction: false,
      typingIndicator: false,
      toolCallMessages: true,
      permissionWaitMessage: "Hang on, you have to ask Nic for that",
    });
    expect(() => parseOptions({ ...required, thinkingReaction: "fire" })).toThrow();
    expect(() => parseOptions({ ...required, permissionWaitMessage: " " })).toThrow();
  });

  test("validates an isolated session directory and explicit chat model", () => {
    expect(parseOptions({
      ...required,
      sessionDirectory: "~/OpenCode/BlueBubbles",
      model: "openai/gpt-5.4-mini",
    })).toMatchObject({
      sessionDirectory: "~/OpenCode/BlueBubbles",
      model: "openai/gpt-5.4-mini",
    });
    expect(() => parseOptions({ ...required, model: "gpt-5.4-mini" })).toThrow();
    expect(() => parseOptions({ ...required, sessionDirectory: " " })).toThrow();
  });

  test("allows only exact, unique, non-administrative automatic tools", () => {
    expect(parseOptions({ ...required, allowedTools: ["plex_restart"] }).allowedTools).toEqual(["plex_restart"]);
    for (const allowedTools of [["*"], ["bash"], ["bluebubbles_health"], ["plex_restart", "plex_restart"]]) {
      expect(() => parseOptions({ ...required, allowedTools })).toThrow();
    }
  });

  test("validates personality token definitions", () => {
    expect(parseOptions({
      ...required,
      personalityTokens: {
        silly_humor: { value: 50, description: "Controls playful humor." },
      },
    }).personalityTokens.silly_humor).toEqual({ value: 50, description: "Controls playful humor." });
    expect(() => parseOptions({ ...required, personalityTokens: { Humor: { value: 50, description: "No" } } })).toThrow();
    expect(() => parseOptions({ ...required, personalityTokens: { humor: { value: 101, description: "No" } } })).toThrow();
  });
});
