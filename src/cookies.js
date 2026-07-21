import { signCookieValue, verifyCookieValue } from "./security.js";

export function parseCookies(cookieHeader = "") {
  const cookies = new Map();

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || !rawValue.length) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join("=")));
  }

  return cookies;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.secure) parts.push("Secure");

  return parts.join("; ");
}

export function getSignedCookie(req, name) {
  const cookies = parseCookies(req.headers.cookie || "");
  const value = cookies.get(name);
  return verifyCookieValue(value);
}

export function setSignedCookie(res, name, value, options = {}) {
  appendSetCookie(
    res,
    serializeCookie(name, signCookieValue(value), {
      path: "/",
      sameSite: "Lax",
      ...options,
    }),
  );
}

export function clearCookie(res, name) {
  appendSetCookie(
    res,
    serializeCookie(name, "", {
      path: "/",
      sameSite: "Lax",
      maxAge: 0,
    }),
  );
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookie]);
  } else {
    res.setHeader("Set-Cookie", [existing, cookie]);
  }
}
