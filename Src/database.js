const mongoose = require("mongoose");

const panelSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  panelChannelId: String,
  panelMessageId: String,
  approvalChannelId: { type: String, required: true },
  ticketCategoryId: { type: String, required: true },
  staffRoleIds: { type: [String], default: [] },
  staffUserIds: { type: [String], default: [] },
  questions: {
    type: [{
      label: String,
      placeholder: String,
      style: { type: String, enum: ["short", "paragraph"], default: "short" },
      required: { type: Boolean, default: true },
      maxLength: { type: Number, default: 300 }
    }],
    default: []
  },
  panelContent: { type: String, default: "" },
  panelEmbeds: { type: Array, default: [] },
  welcomeEmbeds: { type: Array, default: [] },
  ticketNameTemplate: { type: String, default: "ticket-{username}" },
  notifyOnReject: { type: Boolean, default: true },
  allowReopen: { type: Boolean, default: true },
  maxOpenTickets: { type: Number, default: 1 }
}, { timestamps: true });

const applicationSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  panelId: { type: mongoose.Schema.Types.ObjectId, ref: "Panel", required: true },
  applicantId: { type: String, required: true, index: true },
  answers: { type: [{ label: String, value: String }], default: [] },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected", "failed"],
    default: "pending",
    index: true
  },
  reviewMessageId: String,
  reviewChannelId: String,
  reviewerId: String,
  reviewedAt: Date,
  rejectionReason: String,
  ticketChannelId: String,
  error: String
}, { timestamps: true });

const ticketSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  panelId: { type: mongoose.Schema.Types.ObjectId, ref: "Panel", required: true },
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Application", required: true },
  applicantId: { type: String, required: true, index: true },
  channelId: { type: String, unique: true, sparse: true },
  status: {
    type: String,
    enum: ["open", "closed", "deleted"],
    default: "open",
    index: true
  },
  claimedBy: String,
  closeReason: String,
  transcriptUrl: String,
  closedBy: String,
  closedAt: Date,
  reopenedAt: Date,
  deletedAt: Date
}, { timestamps: true });

const auditSchema = new mongoose.Schema({
  guildId: String,
  actorId: String,
  action: String,
  targetId: String,
  details: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

panelSchema.index({ guildId: 1, name: 1 });
applicationSchema.index({ panelId: 1, applicantId: 1, status: 1 });
ticketSchema.index({ guildId: 1, applicantId: 1, status: 1 });

const Panel = mongoose.model("Panel", panelSchema);
const Application = mongoose.model("Application", applicationSchema);
const Ticket = mongoose.model("Ticket", ticketSchema);
const AuditLog = mongoose.model("AuditLog", auditSchema);

async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing");
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000
  });

  console.log("MongoDB connected");
}

async function audit(guildId, actorId, action, targetId, details = {}) {
  return AuditLog.create({
    guildId,
    actorId,
    action,
    targetId,
    details
  });
}

module.exports = {
  mongoose,
  Panel,
  Application,
  Ticket,
  AuditLog,
  connectDatabase,
  audit
};
