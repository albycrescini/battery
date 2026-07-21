import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "./config.js";

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function fromBase64Url(input) {
  return Buffer.from(input, "base64url");
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function hmac(value) {
  return createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
}

export function signCookieValue(value) {
  const encoded = base64Url(value);
  return `${encoded}.${hmac(encoded)}`;
}

export function verifyCookieValue(signedValue) {
  if (!signedValue || !signedValue.includes(".")) return null;
  const [encoded, signature] = signedValue.split(".");
  if (!encoded || !signature || !timingSafeEqualString(hmac(encoded), signature)) {
    return null;
  }

  try {
    return fromBase64Url(encoded).toString("utf8");
  } catch {
    return null;
  }
}

export function encryptSecret(value) {
  if (!value) return null;

  const key = createHash("sha256").update(config.sessionSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString(
    "base64url",
  )}`;
}

export function decryptSecret(value) {
  if (!value) return null;

  const [version, iv, tag, encrypted] = value.split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) {
    throw new Error("Unsupported encrypted secret format");
  }

  const key = createHash("sha256").update(config.sessionSecret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
