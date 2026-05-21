import { NextResponse } from "next/server";
import { isSettledSuccessful } from "@/lib/authorizeNet";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";
import { calculateCustomerValueMetrics } from "@/lib/customerValue";

interface RebuildStats {
  customerId: string;
  email: string;
  authorizeNetTransactionsMatched: number;
  nmiTransactionsMatched: number;
  totalGatewayPaymentsFound: number;
  wooPaidTotal: number;
  authorizeNetPaidTotal: number;
  nmiQuickPayPaidTotal: number;
  gatewayOnlyPaidTotal: number;
  subscriptionPaidTotal: number;
  rankingTotal: number;
  beforeRankingTotal: number;
  changed: boolean;
  matchedTransactionIds: string[];
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function POST(request: Request) {
  try {
    await connectToDatabase();
    const body = (await request.json()) as { customerId?: string; email?: string; emailLike?: string; limit?: number; dryRun?: boolean };
    
    const limit = Math.min(body.limit ?? 1, 100);
    const dryRun = body.dryRun !== false;
    const stats: RebuildStats[] = [];

    // Find customers to rebuild
    const customerQuery: Record<string, unknown> = {};
    if (body.customerId) {
      customerQuery._id = body.customerId;
    } else if (body.email) {
      customerQuery.normalizedEmail = body.email.toLowerCase();
    } else if (body.emailLike) {
      const escaped = escapeRegex(body.emailLike);
      customerQuery.normalizedEmail = { $regex: escaped, $options: "i" };
    }

    const customers = await Customer.find(customerQuery).limit(limit).lean<(CustomerDocument & { _id: unknown })[]>();

    if (!customers.length) {
      return NextResponse.json({ error: "No customers found", stats }, { status: 404 });
    }

    for (const customer of customers) {
      const email = customer.normalizedEmail || customer.email?.toLowerCase() || "";
      const customerId = String(customer._id);
      const orderNumbers = (customer.orders ?? []).map((o) => o.orderNumber).filter(Boolean);
      const profileIds = Array.from(
        new Set([customer.gatewayVerification?.customerProfileId, ...(customer.gatewayPayments ?? []).map((p) => p.customerProfileId)].map(String).filter(Boolean))
      );
      const nameParts = customer.name?.trim().split(/\s+/).filter((p) => p.length > 1) ?? [];

      // Find matching gateway transactions
      const authorizeNetConditions = [
        ...(email ? [{ normalizedEmail: email }, { emailNormalized: email }, { customerEmail: email }] : []),
        { matchedCustomerId: customerId },
        ...(orderNumbers.length ? [{ invoiceNumber: { $in: orderNumbers } }] : []),
        ...(profileIds.length ? [{ customerProfileId: { $in: profileIds } }, { customerPaymentProfileId: { $in: profileIds } }] : []),
        ...(nameParts.length >= 2 ? [{ customerName: { $regex: `^${nameParts.map(escapeRegex).join("\\s+")}`, $options: "i" } }] : []),
      ];

      const authNetTransactions = authorizeNetConditions.length
        ? await AuthorizeNetTransaction.find({ $or: authorizeNetConditions })
            .select({ transactionId: 1, transactionStatus: 1, amount: 1, submittedAt: 1, settledAt: 1, invoiceNumber: 1, cardLast4: 1 })
            .lean<AuthorizeNetTransactionDocument[]>()
        : [];

      const phone = customer.phone?.replace(/\D/g, "") ?? "";
      const nmiConditions = [
        ...(email ? [{ normalizedEmail: email }, { emailNormalized: email }, { customerEmail: email }] : []),
        { matchedCustomerId: customerId },
        ...(phone.length >= 7 ? [{ normalizedPhone: phone }] : []),
        ...(orderNumbers.length ? [{ invoiceNumber: { $in: orderNumbers } }] : []),
        ...(profileIds.length ? [{ customerVaultId: { $in: profileIds } }] : []),
        ...(nameParts.length >= 2 ? [{ customerName: { $regex: `^${nameParts.map(escapeRegex).join("\\s+")}`, $options: "i" } }] : []),
      ];

      const nmiTransactions = nmiConditions.length
        ? await NmiQuickPayTransaction.find({ $or: nmiConditions })
            .select({ transactionId: 1, transactionStatus: 1, amount: 1, submittedAt: 1, settledAt: 1, invoiceNumber: 1, cardLast4: 1 })
            .lean<NmiQuickPayTransactionDocument[]>()
        : [];

      // Load other payment sources for metrics calculation
      const wooOrders = await WooCommerceOrderRecord.find({ wooCentral: customerId, isPaid: true })
        .select({ orderNumber: 1, total: 1, paidAmount: 1, dateCreated: 1 })
        .lean<WooCommerceOrderDocument[]>();

      const subscriptions = await WooCommerceSubscriptionRecord.find({ wooCentral: customerId, status: "active" })
        .select({ status: 1, startDate: 1 })
        .lean<WooCommerceSubscriptionDocument[]>();

      // Calculate metrics
      const metrics = calculateCustomerValueMetrics({
        customer,
        wooOrders,
        authorizeNetTransactions: authNetTransactions,
        nmiTransactions: nmiTransactions,
        subscriptions,
      });

      const matchedTransactionIds = [
        ...authNetTransactions.filter((t) => isSettledSuccessful(t.transactionStatus ?? "")).map((t) => t.transactionId),
        ...nmiTransactions.filter((t) => t.transactionStatus === "success").map((t) => t.transactionId),
      ];

      const stat: RebuildStats = {
        customerId,
        email: customer.email || "",
        authorizeNetTransactionsMatched: authNetTransactions.length,
        nmiTransactionsMatched: nmiTransactions.length,
        totalGatewayPaymentsFound: matchedTransactionIds.length,
        wooPaidTotal: metrics.wooPaidTotal,
        authorizeNetPaidTotal: metrics.authorizeNetPaidTotal,
        nmiQuickPayPaidTotal: metrics.nmiQuickPayPaidTotal,
        gatewayOnlyPaidTotal: metrics.gatewayOnlyPaidTotal,
        subscriptionPaidTotal: metrics.subscriptionPaidTotal,
        rankingTotal: metrics.rankingTotal,
        beforeRankingTotal: customer.rankingPaidTotal || 0,
        changed: Math.abs(metrics.rankingTotal - (customer.rankingPaidTotal || 0)) > 0.01,
        matchedTransactionIds,
      };

      stats.push(stat);

      // Update customer if not dry run
      if (!dryRun && stat.changed) {
        await Customer.updateOne(
          { _id: customerId },
          {
            $set: {
              paidTotal: metrics.rankingTotal,
              totalPaid: metrics.rankingTotal,
              lifetimeValue: metrics.rankingTotal,
              rankingPaidTotal: metrics.rankingTotal,
              wooPaidTotal: metrics.wooPaidTotal,
              authorizeNetPaidTotal: metrics.authorizeNetPaidTotal,
              nmiQuickPayPaidTotal: metrics.nmiQuickPayPaidTotal,
              gatewayOnlyPaidTotal: metrics.gatewayOnlyPaidTotal,
              subscriptionPaidTotal: metrics.subscriptionPaidTotal,
              attemptedTotal: metrics.attemptedTotal,
              firstPaidDate: metrics.firstPaidDate || customer.firstPaidDate,
              lastPaidDate: metrics.lastPaidDate || customer.lastPaidDate,
              paidMonths: metrics.paidMonths || customer.paidMonths,
              stayWithUsMonths: metrics.stayWithUsMonths || customer.stayWithUsMonths,
              updatedAt: new Date(),
            },
          }
        );
      }
    }

    return NextResponse.json({
      success: true,
      dryRun,
      customersProcessed: customers.length,
      stats,
      summary: {
        totalCustomers: stats.length,
        customersChanged: stats.filter((s) => s.changed).length,
        totalGatewayTransactionsFound: stats.reduce((sum, s) => sum + s.totalGatewayPaymentsFound, 0),
        totalRevenueDifference: stats.reduce((sum, s) => sum + (s.rankingTotal - s.beforeRankingTotal), 0),
      },
    });
  } catch (error) {
    console.error("[rebuild-customer-revenue] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to rebuild customer revenue" },
      { status: 500 }
    );
  }
}
