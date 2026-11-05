import mongoose from 'mongoose';

/** Who did what, from where. Written on every security-relevant action. */
const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    action: { type: String, required: true, index: true },
    outcome: { type: String, enum: ['SUCCESS', 'FAILURE'], default: 'SUCCESS' },
    entity: { type: String, default: null },
    entityId: { type: String, default: null },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

export async function recordAudit(entry) {
  try {
    await AuditLog.create(entry);
  } catch {
    // Auditing must never break the request it is describing.
  }
}
