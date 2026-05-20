import mongoose, { Schema } from "mongoose";

export interface AnalyticsSnapshotDocument {
  key: string;
  payload: Record<string, unknown>;
  generatedAt: string;
  status: "ready" | "partial" | "empty";
  warnings: string[];
  updatedAt: Date;
  createdAt: Date;
}

const analyticsSnapshotSchema = new Schema<AnalyticsSnapshotDocument>(
  {
    key: { type: String, required: true, unique: true, index: true },
    payload: { type: Schema.Types.Mixed, default: () => ({}) },
    generatedAt: { type: String, default: "", index: true },
    status: { type: String, enum: ["ready", "partial", "empty"], default: "empty", index: true },
    warnings: { type: [String], default: [] },
  },
  { timestamps: true }
);

analyticsSnapshotSchema.index({ updatedAt: -1 });
analyticsSnapshotSchema.index({ createdAt: -1 });

export const AnalyticsSnapshot = mongoose.models.AnalyticsSnapshot || mongoose.model<AnalyticsSnapshotDocument>("AnalyticsSnapshot", analyticsSnapshotSchema);
