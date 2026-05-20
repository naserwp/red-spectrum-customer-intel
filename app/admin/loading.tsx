import { AdminHeader } from "@/app/admin/_components/AdminHeader";
import { AdminLayout, AdminLoadingState } from "@/app/admin/_components/AdminLayout";

export default function AdminRouteLoading() {
  return <AdminLayout header={<AdminHeader
    title="Customer Intelligence"
    description="Loading Red Spectrum admin data..."
  />}>
    <AdminLoadingState title="Loading admin dashboard..." subtext="Preparing customer, payment, and subscription data..." />
  </AdminLayout>;
}
