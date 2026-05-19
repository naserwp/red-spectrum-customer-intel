import { NextResponse } from "next/server";
import { fetchProfileUsersWithFallback, fetchWordPressProfileUsers, isWooCommerceCustomerFallbackConfigured, isWordPressProfileImportConfigured, ProfileTimeoutError } from "@/lib/wordpressProfiles";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";

export const dynamic = "force-dynamic";

type LeanCustomer = CustomerDocument & { _id: unknown };

function safeNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findCustomerForProfile(user: Awaited<ReturnType<typeof fetchWordPressProfileUsers>>["users"][number]) {
  if (user.normalizedEmail) {
    const customer = await Customer.findOne({ $or: [{ normalizedEmail: user.normalizedEmail }, { email: user.normalizedEmail }] }).lean<LeanCustomer | null>().exec();
    if (customer) return customer;
  }
  if (user.profile.phone.length >= 7) {
    const customer = await Customer.findOne({ phone: { $regex: escapeRegex(user.profile.phone.slice(-7)), $options: "i" } }).lean<LeanCustomer | null>().exec();
    if (customer) return customer;
  }
  if (user.name && user.profile.company) {
    return Customer.findOne({
      name: { $regex: escapeRegex(user.name.split(/\s+/).filter(Boolean).join(".*")), $options: "i" },
      $or: [
        { "businessProfile.company": { $regex: escapeRegex(user.profile.company), $options: "i" } },
        { "orders.billingCompany": { $regex: escapeRegex(user.profile.company), $options: "i" } },
      ],
    }).lean<LeanCustomer | null>().exec();
  }
  return null;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number; dryRun?: boolean };
  const limit = safeNumber(body.limit, 25, 25);
  const offset = safeNumber(body.offset, 0, 1000000);
  const dryRun = body.dryRun === true;
  const warnings: string[] = dryRun ? ["Dry run: no Customer profile records were written."] : [];

  if (!isWordPressProfileImportConfigured() && !isWooCommerceCustomerFallbackConfigured()) {
    return NextResponse.json({
      sourceUsed: "",
      processed: 0,
      matchedCustomers: 0,
      updatedProfiles: 0,
      missingCustomers: 0,
      hasMore: false,
      nextOffset: offset,
      warnings: ["WordPress and WooCommerce customer profile import are not configured."],
    });
  }

  await connectToDatabase();
  const controller = new AbortController();
  try {
    const { users, total, sourceUsed, warnings: sourceWarnings } = await fetchProfileUsersWithFallback({ limit, offset, signal: controller.signal });
    warnings.push(...sourceWarnings);
    let matchedCustomers = 0;
    let updatedProfiles = 0;
    let missingCustomers = 0;
    const importedAt = new Date().toISOString();

    for (const user of users) {
      const customer = await findCustomerForProfile(user);
      if (!customer) {
        missingCustomers += 1;
        continue;
      }
      matchedCustomers += 1;
      if (!dryRun) {
        await Customer.updateOne(
          { _id: customer._id },
          {
            $set: {
              businessProfile: { ...user.profile, importedAt },
              actualCreditLimit: user.profile.creditLimit || customer.actualCreditLimit || null,
              estimatedCreditLimit: user.profile.potentialCreditLimit || user.profile.creditLimit || customer.estimatedCreditLimit,
              phone: customer.phone || user.profile.phone,
              "sourceCoverage.lastSyncedAt": importedAt,
            },
          }
        ).exec();
        updatedProfiles += 1;
      }
    }

    const nextOffset = offset + users.length;
    console.log(`[wordpress-profile-import] source=${sourceUsed} page=${Math.floor(offset / limit) + 1} fetched=${users.length} matched=${matchedCustomers} updated=${dryRun ? 0 : updatedProfiles} skipped=${missingCustomers}`);
    return NextResponse.json({
      processed: users.length,
      sourceUsed,
      matchedCustomers,
      updatedProfiles: dryRun ? 0 : updatedProfiles,
      missingCustomers,
      hasMore: users.length === limit && (total === 0 || nextOffset < total),
      nextOffset,
      warnings,
    });
  } catch (error) {
    const timeoutWarning = error instanceof ProfileTimeoutError || (error instanceof Error && error.name === "AbortError")
      ? "Request timed out during batch fetch"
      : error instanceof Error ? error.message : "WordPress profile import failed.";
    console.log(`[wordpress-profile-import] source=unknown page=${Math.floor(offset / limit) + 1} fetched=0 matched=0 updated=0 skipped=0 warning="${timeoutWarning}"`);
    return NextResponse.json({
      sourceUsed: "",
      processed: 0,
      matchedCustomers: 0,
      updatedProfiles: 0,
      missingCustomers: 0,
      hasMore: false,
      nextOffset: offset,
      warnings: [timeoutWarning],
    });
  }
}
