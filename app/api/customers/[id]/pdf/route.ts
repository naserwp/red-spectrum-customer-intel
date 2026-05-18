import { NextResponse } from "next/server";
import { jsPDF } from "jspdf";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

const money = (value: unknown) => `$${Number(value ?? 0).toFixed(2)}`;
const text = (value: unknown) => String(value ?? "");

function productNames(order: Record<string, unknown>, fallback: string[]) {
  const lineItems = Array.isArray(order.lineItems) && order.lineItems.length ? order.lineItems as Array<Record<string, unknown>> : Array.isArray(order.products) ? order.products as Array<Record<string, unknown>> : [];
  const names = lineItems.map((item) => text(item.name)).filter(Boolean);
  return names.length ? names.join(", ") : fallback.length ? fallback.join(", ") : "the selected product";
}

function buildTemplates(customer: Record<string, unknown>, attemptedOrders: Array<Record<string, unknown>>) {
  const name = text(customer.name).trim().split(/\s+/)[0] || text(customer.name);
  const actualPaid = Number(customer.paidTotal ?? customer.totalPaid ?? 0);
  const latestAttempt = attemptedOrders[0];
  const fallbackProducts = actualPaid > 0 && Array.isArray(customer.paidProducts) ? customer.paidProducts.map(String) : Array.isArray(customer.attemptedProducts) ? customer.attemptedProducts.map(String) : [];
  const products = productNames(latestAttempt ?? {}, fallbackProducts);
  const attemptDate = text(latestAttempt?.attemptedDate || latestAttempt?.dateCreated || customer.lastAttemptDate || "the checkout attempt");
  const attemptAmount = money(customer.attemptedTotal ?? 0);
  const method = text(latestAttempt?.paymentMethodTitle || latestAttempt?.paymentMethod || customer.lastAttemptPaymentMethod || "payment");
  const status = text(latestAttempt?.status || customer.lastAttemptStatus || "not completed");
  const orderNumbers = attemptedOrders.map((order) => `#${text(order.orderNumber)}`).filter(Boolean).join(", ");
  if (actualPaid > 0) {
    return {
      email: `Subject: Thanks for your Red Spectrum order\n\nHi ${name},\n\nThank you for your order for ${products}. I can help with setup, renewal, or matching products that fit your current setup.\n\nBest,\nRed Spectrum Team`,
      sms: `Hi ${name}, this is Red Spectrum. Thanks for your order for ${products}. Want help with setup, renewal, or a matching product recommendation?`,
      call: `Hi ${name}, this is [Rep Name] from Red Spectrum. I am calling to follow up on your purchase of ${products} and see if you need setup help or recommendations for the next best product.`,
      note: `Paid customer. Purchased ${products}. Actual paid total ${money(actualPaid)}. Review upsell, renewal, or support opportunity.`,
    };
  }
  return {
    email: `Subject: Need help completing your Red Spectrum order?\n\nHi ${name},\n\nI noticed you started checkout for ${products} on ${attemptDate}, but the ${method} payment is still ${status} and did not complete.\n\nI can help you finish the order or resend a secure payment link.\n\nWould you like me to help complete the payment?\n\nBest,\nRed Spectrum Team`,
    sms: `Hi ${name}, this is Red Spectrum. Your checkout for ${products} is still ${status} through ${method}. Want me to resend a secure payment link or help finish it?`,
    call: `Hi ${name}, this is [Rep Name] from Red Spectrum. I am calling because I saw you started checkout for ${products}, but the ${method} payment is still ${status}. I wanted to see if you need help completing the payment or prefer another payment option.`,
    note: `Very hot lead. ${attemptedOrders.length} WooCommerce attempted order${attemptedOrders.length === 1 ? "" : "s"} via ${method}. Orders: ${orderNumbers || "N/A"}. Attempted products: ${products}. Attempted total: ${attemptAmount}. Payment not completed. Follow up by phone/SMS and offer secure payment link or alternate payment method. Do not mark as paid until verified.`,
  };
}

async function findCustomerByIdOrEmail(rawId: string) {
  const id = decodeURIComponent(rawId).trim();
  if (mongoose.isValidObjectId(id)) return Customer.findById(id).lean<Record<string, unknown> | null>();
  return Customer.findOne({ email: id.toLowerCase() }).lean<Record<string, unknown> | null>();
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  await connectToDatabase();
  const { id } = await params;
  const customer = await findCustomerByIdOrEmail(id);
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });

  const orders = (Array.isArray(customer.orders) ? customer.orders as Array<Record<string, unknown>> : [])
    .sort((a, b) => new Date(text(b.dateCreated)).getTime() - new Date(text(a.dateCreated)).getTime());
  const attemptedOrders = orders.filter((order) => Boolean(order.isAttempted));
  const attemptedProducts = Array.from(new Set(attemptedOrders.flatMap((order) => {
    const lineItems = Array.isArray(order.lineItems) && order.lineItems.length ? order.lineItems as Array<Record<string, unknown>> : Array.isArray(order.products) ? order.products as Array<Record<string, unknown>> : [];
    return lineItems.map((item) => text(item.name)).filter(Boolean);
  })));
  const templates = buildTemplates(customer, attemptedOrders);
  const latestRelevantOrder = attemptedOrders[0] ?? orders[0] ?? {};
  const verification = (latestRelevantOrder.gatewayVerification ?? customer.gatewayVerification ?? {}) as Record<string, unknown>;

  const doc = new jsPDF();
  let y = 14;
  const ensure = (space = 8) => { if (y + space > 280) { doc.addPage(); y = 14; } };
  const line = (label: string, value: string) => { ensure(); doc.text(`${label}: ${value}`, 14, y); y += 7; };
  const para = (label: string, value: string) => {
    ensure(18);
    doc.setFontSize(11);
    doc.text(`${label}:`, 14, y); y += 6;
    doc.setFontSize(9);
    const split = doc.splitTextToSize(value, 180);
    ensure(split.length * 5 + 2);
    doc.text(split, 14, y); y += split.length * 5 + 4;
  };

  doc.setFontSize(16);
  doc.text("Customer Intelligence Report", 14, y); y += 10;
  doc.setFontSize(11);
  line("Name", text(customer.name));
  line("Email", text(customer.email));
  line("Phone", text(customer.phone));
  line("Actual Paid Amount", money(customer.paidTotal ?? customer.totalPaid));
  line("Attempted Amount", money(customer.attemptedTotal));
  line("Paid Order Count", text(customer.paidOrderCount ?? 0));
  line("Attempted Order Count", text(customer.attemptedOrderCount ?? 0));
  line("Lead Status", text(customer.leadStatus));
  line("Payment Status", text(customer.paymentStatus));
  line("Last Paid Date", text(customer.lastPaidDate));
  line("Last Attempt Date", text(customer.lastAttemptDate));
  line("Subscription Status", text(customer.subscriptionStatus));
  line("Risk", text(customer.riskLevel));
  line("Tier", Number(customer.paidTotal ?? customer.totalPaid ?? 0) > 0 ? text(customer.tier) : "Lead");

  para("Order/Product Timeline", orders.slice(0, 10).map((order) => `${text(order.dateCreated)} | #${text(order.orderNumber)} | ${text(order.status)} | ${text(order.paymentMethodTitle || order.paymentMethod)} | ${productNames(order, [])} | ${money(order.total)} | ${order.isPaid ? "Paid" : "Attempted"}`).join("\n") || "No WooCommerce order timeline synced.");
  para("Attempted Products", attemptedProducts.join(", ") || "No attempted products found.");
  para("Payment Verification", `WooCommerce: ${text(latestRelevantOrder.status || customer.lastAttemptStatus)}\nMethod: ${text(latestRelevantOrder.paymentMethodTitle || latestRelevantOrder.paymentMethod || customer.lastAttemptPaymentMethod)}\nGateway provider: ${text(verification.provider)}\nGateway status: ${text(verification.transactionStatus || "Not verified")}\nConfidence: ${text(verification.confidence || "not_found")}\nMatched by: ${text(verification.matchedBy || "-")}\nTransaction ID: ${text(verification.transactionId || "-")}\nPayment Intent ID: ${text(verification.paymentIntentId || "-")}\nCharge ID: ${text(verification.chargeId || "-")}\nStripe Customer ID: ${text(verification.stripeCustomerId || "-")}\nLast checked: ${text(verification.lastCheckedAt || "-")}\nNotes: ${text(verification.notes || "Manual verification required")}`);
  para("Sales Executive Follow-Up Plan", text(customer.nextAction || "Manual review"));
  para("Email Template", templates.email);
  para("SMS Template", templates.sms);
  para("Call Script", templates.call);
  para("Internal CRM Note", templates.note);

  const bytes = doc.output("arraybuffer");
  return new NextResponse(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="customer-${id}.pdf"` } });
}
