import { NextResponse } from "next/server";
import { jsPDF } from "jspdf";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  await connectToDatabase();
  const { id } = await params;
  const customer = (await Customer.findById(id).lean()) as Record<string, unknown> | null;
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });

  const doc = new jsPDF();
  let y = 14;
  const line = (label: string, value: string) => { doc.text(`${label}: ${value}`, 14, y); y += 7; };
  doc.setFontSize(16);
  doc.text("Customer Intelligence Report", 14, y); y += 10;
  doc.setFontSize(11);
  line("Name", String(customer.name ?? ""));
  line("Email", String(customer.email ?? ""));
  line("Phone", String(customer.phone ?? ""));
  line("Total Paid", `$${Number(customer.totalPaid ?? 0).toFixed(2)}`);
  line("Order Count", String(customer.orderCount ?? 0));
  line("Average Order Value", `$${Number(customer.averageOrderValue ?? 0).toFixed(2)}`);
  line("First Order", String(customer.firstOrderDate ?? ""));
  line("Last Order", String(customer.lastOrderDate ?? ""));
  line("Subscription Status", String(customer.subscriptionStatus ?? ""));
  line("Active Subscriptions", String(customer.activeSubscriptions ?? 0));
  line("Failed Payments", String(customer.failedPayments ?? 0));
  line("Refunds", String(customer.refunds ?? 0));
  line("Chargebacks", String(customer.chargebacks ?? 0));
  line("Estimated Credit", `$${Number(customer.estimatedCreditLimit ?? 0).toFixed(2)}`);
  line("Actual Credit", customer.actualCreditLimit == null ? "Not reported" : `$${Number(customer.actualCreditLimit).toFixed(2)}`);
  line("Tier", String(customer.tier ?? ""));
  line("Risk", String(customer.riskLevel ?? ""));
  line("Score", String(customer.score ?? ""));
  line("Recommended Action", String(customer.recommendedAction ?? ""));
  y += 4;
  doc.text("AI Summary:", 14, y); y += 6;
  doc.setFontSize(10);
  const split = doc.splitTextToSize(String(customer.aiSummary ?? ""), 180);
  doc.text(split, 14, y);

  const bytes = doc.output("arraybuffer");
  return new NextResponse(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="customer-${id}.pdf"` } });
}
