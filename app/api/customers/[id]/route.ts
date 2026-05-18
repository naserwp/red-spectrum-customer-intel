import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

async function findCustomerByIdOrEmail(rawId: string) {
  const id = decodeURIComponent(rawId).trim();
  if (mongoose.isValidObjectId(id)) {
    return Customer.findById(id).lean();
  }
  return Customer.findOne({ email: id.toLowerCase() }).lean();
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  await connectToDatabase();
  const { id } = await params;
  const customer = await findCustomerByIdOrEmail(id);
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  return NextResponse.json({ customer });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connectToDatabase();
  const { id } = await params;
  const lookupId = decodeURIComponent(id).trim();
  const body = (await request.json()) as { notes?: string; tags?: string[] };
  const query = mongoose.isValidObjectId(lookupId) ? { _id: lookupId } : { email: lookupId.toLowerCase() };
  const updated = await Customer.findOneAndUpdate(
    query,
    { $set: { notes: body.notes ?? "", tags: body.tags ?? [] } },
    { new: true }
  ).lean();

  if (!updated) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  return NextResponse.json({ customer: updated, message: "Customer notes updated." });
}
