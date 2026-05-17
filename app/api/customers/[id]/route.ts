import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  await connectToDatabase();
  const { id } = await params;
  const customer = await Customer.findById(id).lean();
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  return NextResponse.json({ customer });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connectToDatabase();
  const { id } = await params;
  const body = (await request.json()) as { notes?: unknown; tags?: unknown };

  const notes = typeof body.notes === "string" ? body.notes.slice(0, 5000) : "";
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean).slice(0, 25)
    : [];

  const updated = await Customer.findByIdAndUpdate(id, { $set: { notes, tags } }, { new: true }).lean();
  if (!updated) return NextResponse.json({ error: "Customer not found." }, { status: 404 });

  return NextResponse.json({ customer: updated, message: "Customer notes and tags updated." });
}
