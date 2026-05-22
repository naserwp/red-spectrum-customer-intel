import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { isSettledSuccessful } from "@/lib/authorizeNet";

export async function GET() {
  try {
    await connectToDatabase();
    
    // Find James Houston
    const customer = await Customer.findOne({
      $or: [
        { name: /james.*houston/i },
        { email: /james.*houston/i },
      ],
    }).lean<(CustomerDocument & { _id: unknown }) | null>();

    if (!customer) {
      return NextResponse.json({ error: "James Houston not found" }, { status: 404 });
    }

    const customerId = String(customer._id);
    const email = customer.normalizedEmail || customer.email?.toLowerCase() || "";

    // Find all Authorize.net transactions that match
    const allAuthNetTransactions = await AuthorizeNetTransaction.find({
      $or: [
        { normalizedEmail: email },
        { emailNormalized: email },
        { customerEmail: email },
        { matchedCustomerId: customerId },
      ],
    }).lean<AuthorizeNetTransactionDocument[]>();

    // Filter to settled transactions
    const settledTransactions = allAuthNetTransactions.filter((t) =>
      isSettledSuccessful(t.transactionStatus ?? "")
    );

    // Calculate totals
    const settledTotal = settledTransactions.reduce((sum, t) => sum + Number(t.amount ?? 0), 0);
    const totalRecordsInCustomer = Number(customer.gatewayPayments?.length ?? 0);
    const storedPaidTotal = Number(customer.rankingPaidTotal ?? customer.paidTotal ?? customer.totalPaid ?? 0);

    return NextResponse.json({
      customer: {
        _id: customerId,
        name: customer.name,
        email: customer.email,
        currentStoredPaidTotal: storedPaidTotal,
        gatewayPaymentsInRecord: totalRecordsInCustomer,
      },
      authorizenetData: {
        totalRecordsInDatabase: allAuthNetTransactions.length,
        settledRecords: settledTransactions.length,
        settledTotal: settledTotal.toFixed(2),
        difference: (settledTotal - storedPaidTotal).toFixed(2),
        shouldBeAdjustedTo: settledTotal.toFixed(2),
        transactions: settledTransactions.map((t) => ({
          transactionId: t.transactionId,
          amount: t.amount,
          status: t.transactionStatus,
          submittedAt: t.submittedAt,
          settledAt: t.settledAt,
          invoiceNumber: t.invoiceNumber,
          matchedCustomerId: t.matchedCustomerId,
        })),
      },
      recommendation: settledTotal > storedPaidTotal 
        ? `Customer revenue should be updated from ${storedPaidTotal.toFixed(2)} to ${settledTotal.toFixed(2)} (difference: ${(settledTotal - storedPaidTotal).toFixed(2)})`
        : "Revenue appears correct",
    });
  } catch (error) {
    console.error("[test-james-houston] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Test failed" },
      { status: 500 }
    );
  }
}
