import { NextResponse } from "next/server";
import { adminSessionCookieName, adminSessionMaxAge, createAdminSession, getAdminCredentials } from "@/lib/adminAuth";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { email?: string; password?: string };
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const credentials = getAdminCredentials();

  if (email !== credentials.email.trim().toLowerCase() || password !== credentials.password) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(adminSessionCookieName, await createAdminSession(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: adminSessionMaxAge,
  });
  return response;
}
