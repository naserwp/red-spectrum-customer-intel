export const adminSessionCookieName = "rs_admin_session";

const defaultSessionSecret = "red-spectrum-local-mvp-session-secret";
const sessionTtlSeconds = 60 * 60 * 8;

type AdminSessionPayload = {
  email: string;
  exp: number;
};

function sessionSecret() {
  return process.env.SESSION_SECRET || defaultSessionSecret;
}

function base64UrlEncode(value: string) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return atob(padded);
}

async function sign(value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

export function getAdminCredentials() {
  return {
    email: process.env.ADMIN_EMAIL || "nasir@factiiv.io",
    password: process.env.ADMIN_PASSWORD || "Win@Intelligence2026",
  };
}

export async function createAdminSession(email: string) {
  const payload: AdminSessionPayload = {
    email: email.trim().toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + sessionTtlSeconds,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function verifyAdminSession(value?: string | null) {
  if (!value) return false;
  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature) return false;
  const expected = await sign(encodedPayload);
  if (expected !== signature) return false;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as AdminSessionPayload;
    return Boolean(payload.email && payload.exp > Math.floor(Date.now() / 1000));
  } catch {
    return false;
  }
}

export const adminSessionMaxAge = sessionTtlSeconds;
