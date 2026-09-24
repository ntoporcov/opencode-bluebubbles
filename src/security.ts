import {
  createHash,
  randomBytes,
  randomInt,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_PREFIX = "scrypt";
const SCRYPT_KEY_LENGTH = 32;
const REVIEW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePin(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, "0");
}

export function generateReviewCode(length = 4): string {
  if (!Number.isSafeInteger(length) || length <= 0) throw new RangeError("length must be a positive integer");
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += REVIEW_ALPHABET[randomInt(0, REVIEW_ALPHABET.length)];
  }
  return code;
}

export function hashSecret(secret: string, salt: Uint8Array = randomBytes(16)): string {
  const saltBuffer = Buffer.from(salt);
  const derived = scryptSync(secret, saltBuffer, SCRYPT_KEY_LENGTH);
  return `${SCRYPT_PREFIX}$${saltBuffer.toString("base64url")}$${derived.toString("base64url")}`;
}

export function hashSecretAsync(secret: string, salt: Uint8Array = randomBytes(16)): Promise<string> {
  const saltBuffer = Buffer.from(salt);
  return new Promise((resolve, reject) => {
    scrypt(secret, saltBuffer, SCRYPT_KEY_LENGTH, (error, derived) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`${SCRYPT_PREFIX}$${saltBuffer.toString("base64url")}$${derived.toString("base64url")}`);
    });
  });
}

function decodeHash(encoded: string): { salt: Buffer; hash: Buffer } | undefined {
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== SCRYPT_PREFIX || !parts[1] || !parts[2]) return undefined;
  try {
    const salt = Buffer.from(parts[1], "base64url");
    const hash = Buffer.from(parts[2], "base64url");
    if (salt.length < 16 || hash.length !== SCRYPT_KEY_LENGTH) return undefined;
    return { salt, hash };
  } catch {
    return undefined;
  }
}

export function verifySecret(secret: string, encoded: string): boolean {
  const decoded = decodeHash(encoded);
  if (!decoded) return false;
  const candidate = scryptSync(secret, decoded.salt, decoded.hash.length);
  return timingSafeEqual(candidate, decoded.hash);
}

export async function verifySecretAsync(secret: string, encoded: string): Promise<boolean> {
  const decoded = decodeHash(encoded);
  if (!decoded) return false;
  const candidate = await new Promise<Buffer>((resolve, reject) => {
    scrypt(secret, decoded.salt, decoded.hash.length, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
  return timingSafeEqual(candidate, decoded.hash);
}

export function normalizeSenderHandle(handle: string): string {
  const normalized = handle.trim();
  if (!normalized) throw new Error("sender handle must not be empty");
  return normalized.includes("@") ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function relationshipKey(instanceId: string, chatGuid: string, senderHandle: string): string {
  const values = [instanceId.trim(), chatGuid.trim(), normalizeSenderHandle(senderHandle)];
  if (values.some((value) => value.length === 0)) throw new Error("relationship key fields must not be empty");
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function maskIdentifier(identifier: string): string {
  const value = identifier.trim();
  const at = value.indexOf("@");
  if (at > 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    return `${local[0]}***@${domain[0] ?? "*"}***`;
  }
  const visible = Array.from(value).slice(-2).join("");
  return visible ? `***${visible}` : "***";
}

export function redactUrl(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s"'<>]+/giu, (match) => {
    try {
      const url = new URL(match);
      if (url.username || url.password) {
        url.username = "";
        url.password = "";
      }
      if (url.search || url.hash) return `${url.origin}${url.pathname}?[REDACTED]`;
      return url.toString();
    } catch {
      return "[REDACTED URL]";
    }
  });
}

export function redactSensitive(value: string, secrets: readonly string[] = []): string {
  let redacted = redactUrl(value)
    .replace(/\b(password|token|guid|pin|review[_ -]?code)\s*[:=]\s*[^\s,;&]+/giu, "$1=[REDACTED]");
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function safeError(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSensitive(message.replace(/[\u0000-\u001f\u007f]/gu, " "), secrets);
}
