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
  const body = (await request.json()) as { notes?: string; tags?: string[] };
  const updated = await Customer.findByIdAndUpdate(
    id,
    { $set: { notes: body.notes ?? "", tags: body.tags ?? [] } },
    { new: true }
  ).lean();

  if (!updated) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  return NextResponse.json({ customer: updated, message: "Customer notes updated." });
}
