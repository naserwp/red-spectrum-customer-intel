import mongoose, { Schema } from "mongoose";

export type SyncJobType = "woocommerce_backfill_orders" | "rebuild_customers";
export type SyncJobStatus = "running" | "completed" | "failed" | "partial";

export interface SyncJobDocument {
  jobType: SyncJobType;
  status: SyncJobStatus;
  startedAt: string;
  finishedAt: string;
  progress: number;
  totalPages: number;
  pagesFetched: number;
  recordsProcessed: number;
  errors: string[];
  warnings: string[];
  lastCursor: {
    page: number;
    status: string;
  };
}

const syncJobSchema = new Schema<SyncJobDocument>(
  {
    jobType: { type: String, enum: ["woocommerce_backfill_orders", "rebuild_customers"], required: true, index: true },
    status: { type: String, enum: ["running", "completed", "failed", "partial"], required: true, index: true },
    startedAt: { type: String, required: true },
    finishedAt: { type: String, default: "" },
    progress: { type: Number, default: 0 },
    totalPages: { type: Number, default: 0 },
    pagesFetched: { type: Number, default: 0 },
    recordsProcessed: { type: Number, default: 0 },
    errors: { type: [String], default: [] },
    warnings: { type: [String], default: [] },
    lastCursor: {
      page: { type: Number, default: 0 },
      status: { type: String, default: "" },
    },
  },
  { timestamps: true, suppressReservedKeysWarning: true }
);

syncJobSchema.index({ jobType: 1, startedAt: -1 });

export const SyncJob = mongoose.models.SyncJob || mongoose.model<SyncJobDocument>("SyncJob", syncJobSchema);
