import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";
import { findBestCustomerByIdOrEmail } from "@/lib/customerLookup";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  await connectToDatabase();
  const { id } = await params;
  const safeId = decodeURIComponent(id);
  const result = await findBestCustomerByIdOrEmail(safeId);
  if (!result.customer) {
    console.log(`[customer-detail] lookup failed id=${safeId} reason=${result.selectedDocumentReason}`);
    return NextResponse.json({ error: "Customer not found.", lookup: { id: safeId, reason: result.selectedDocumentReason } }, { status: 404 });
  }
  console.log(`[customer-detail] lookup id=${safeId} reason=${result.selectedDocumentReason} documentsWithSameEmail=${result.documentsWithSameEmail}`);
  return NextResponse.json({
    customer: {
      ...result.customer,
      orders: result.customer.orders ?? [],
      productJourney: result.customer.productJourney ?? [],
      gatewayPayments: result.customer.gatewayPayments ?? [],
      tags: result.customer.tags ?? [],
      notes: result.customer.notes ?? "",
    },
    lookup: { reason: result.selectedDocumentReason, documentsWithSameEmail: result.documentsWithSameEmail },
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connectToDatabase();
  const { id } = await params;
  const body = (await request.json()) as { notes?: string; tags?: string[] };
  const safeId = decodeURIComponent(id);
  const { customer } = await findBestCustomerByIdOrEmail(safeId);
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });

  const updated = await Customer.findByIdAndUpdate(
    customer._id,
    { $set: { notes: body.notes ?? "", tags: body.tags ?? [] } },
    { new: true }
  ).lean();

  if (!updated) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  return NextResponse.json({ customer: updated, message: "Customer notes updated." });
}
