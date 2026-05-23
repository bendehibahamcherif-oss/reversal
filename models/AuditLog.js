import mongoose from 'mongoose';

const AuditLogSchema = new mongoose.Schema(
  {
    type: String,
    method: String,
    path: String,
    user: String,
    status: Number,
    durationMs: Number,
  },
  {
    timestamps: true,
  }
);

export default mongoose.model(
  'AuditLog',
  AuditLogSchema
);
