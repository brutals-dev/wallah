const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Panel, Application, Ticket, AuditLog, audit } = require("./database");
const { publishPanel } = require("./bot");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(1, Number(process.env.MAX_UPLOAD_MB || 8)) * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    cb(allowed.includes(file.mimetype) ? null : new Error("Unsupported image type"), allowed.includes(file.mimetype));
  }
});

const s3 = process.env.S3_ENDPOINT ? new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || "auto",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
  }
}) : null;

function requireLogin(req, res, next) {
  if (!req.session?.authenticated) {
    return res.redirect("/login");
  }
  next();
}

function csrf(req, res, next) {
  if (req.method === "GET") {
    req.session.csrfToken ||= crypto.randomBytes(32).toString("hex");
    return next();
  }

  if (req.method === "POST") {
    const token = req.body?._csrf;
    if (!token || token !== req.session.csrfToken) {
      return res.status(403).send("Invalid security token. Refresh the page and try again.");
    }
  }

  next();
}

function page(title, body, req) {
  const token = req.session?.csrfToken || "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | AVENGED</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#101114;color:#eee;font:16px Arial,sans-serif}
header{padding:18px;background:#1b1c22;border-bottom:1px solid #34353c}
main{max-width:1000px;margin:auto;padding:18px}
nav{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
a,button{color:#fff;background:#8f222a;padding:11px 14px;border:0;border-radius:8px;text-decoration:none;cursor:pointer}
input,textarea,select{width:100%;padding:12px;margin:6px 0 14px;background:#202127;color:#fff;border:1px solid #484951;border-radius:7px}
textarea{min-height:100px}label{display:block;margin-top:10px}
.card{background:#1b1c22;border:1px solid #34353c;border-radius:12px;padding:16px;margin:12px 0;overflow-wrap:anywhere}
small{color:#aaa}.danger{background:#5b2020}
</style>
</head><body>
<header><strong>AVENGED TICKET SYSTEM</strong></header>
<main>
${req.session?.authenticated ? `<nav>
<a href="/">Overview</a><a href="/panels">Panels</a><a href="/applications">Applications</a>
<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${token}"><button>Log out</button></form>
</nav>` : ""}
<h2>${title}</h2>
${body}
</main></body></html>`;
}

router.use(express.urlencoded({ extended: false, limit: "100kb" }));
router.use(express.json({ limit: "100kb" }));
router.use(session({
  name: "avenged.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 8
  }
}));
router.use(csrf);

router.get("/login", (req, res) => {
  res.send(page("Dashboard Login", `
    <div class="card"><form method="post" action="/login">
    <input type="hidden" name="_csrf" value="${req.session.csrfToken}">
    <label>Username</label><input name="username" required autocomplete="username">
    <label>Password</label><input type="password" name="password" required autocomplete="current-password">
    <button>Sign in</button></form></div>`, req));
});

router.post("/login", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
}), async (req, res) => {
  const username = process.env.DASHBOARD_USERNAME;
  const hash = process.env.DASHBOARD_PASSWORD_HASH;

  if (!username || !hash ||
      req.body.username !== username ||
      !await bcrypt.compare(req.body.password || "", hash)) {
    return res.status(401).send(page("Login Failed", "<p>Invalid credentials.</p><a href='/login'>Try again</a>", req));
  }

  req.session.regenerate(err => {
    if (err) return res.status(500).send("Could not create session.");
    req.session.authenticated = true;
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.redirect("/");
  });
});

router.post("/logout", requireLogin, (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

router.get("/", requireLogin, async (req, res) => {
  const [panels, pending, approved, rejected, openTickets] = await Promise.all([
    Panel.countDocuments(),
    Application.countDocuments({ status: "pending" }),
    Application.countDocuments({ status: "approved" }),
    Application.countDocuments({ status: "rejected" }),
    Ticket.countDocuments({ status: "open" })
  ]);

  res.send(page("Overview", `
    <div class="card">Panels: <strong>${panels}</strong></div>
    <div class="card">Pending applications: <strong>${pending}</strong></div>
    <div class="card">Approved applications: <strong>${approved}</strong></div>
    <div class="card">Rejected applications: <strong>${rejected}</strong></div>
    <div class="card">Open tickets: <strong>${openTickets}</strong></div>
    <a href="/panels">Manage Panels</a>`, req));
});

router.get("/panels", requireLogin, async (req, res) => {
  const panels = await Panel.find().sort({ createdAt: -1 }).lean();

  const list = panels.map(p => `
    <div class="card">
      <strong>${escapeHtml(p.name)}</strong>
      <p><small>ID: ${p._id} | ${p.enabled ? "Enabled" : "Disabled"}</small></p>
      <p><small>Panel channel: ${escapeHtml(p.panelChannelId || "Not published")}</small></p>
      <a href="/panels/${p._id}">Edit</a>
      <form method="post" action="/panels/${p._id}/toggle">
      <input type="hidden" name="_csrf" value="${req.session.csrfToken}">
      <button>${p.enabled ? "Disable" : "Enable"}</button></form>
    </div>`).join("");

  res.send(page("Ticket Panels", `
    <a href="/panels/new">Create panel</a>
    ${list || "<p>No panels yet.</p>"}`, req));
});

router.get("/panels/new", requireLogin, (req, res) => {
  res.send(panelForm(req, null));
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function panelForm(req, panel) {
  const p = panel || {};
  const questions = JSON.stringify(p.questions || [
    { label: "Roblox username", style: "short", required: true, maxLength: 100 }
  ], null, 2);

  const embeds = JSON.stringify(p.panelEmbeds || [], null, 2);

  return page(panel ? "Edit Panel" : "Create Panel", `
  <div class="card">
  <form method="post" action="${panel ? `/panels/${p._id}` : "/panels"}">
  <input type="hidden" name="_csrf" value="${req.session.csrfToken}">
  <label>Panel name</label><input name="name" maxlength="80" required value="${escapeHtml(p.name || "")}">
  <label>Discord panel channel ID</label><input name="panelChannelId" required value="${escapeHtml(p.panelChannelId || "")}">
  <label>Approval channel ID</label><input name="approvalChannelId" required value="${escapeHtml(p.approvalChannelId || "")}">
  <label>Ticket category ID</label><input name="ticketCategoryId" required value="${escapeHtml(p.ticketCategoryId || "")}">
  <label>Staff role IDs (comma-separated)</label><input name="staffRoleIds" value="${escapeHtml((p.staffRoleIds || []).join(","))}">
  <label>Authorised staff user IDs (comma-separated)</label><input name="staffUserIds" value="${escapeHtml((p.staffUserIds || []).join(","))}">
  <label>Ticket naming template</label><input name="ticketNameTemplate" value="${escapeHtml(p.ticketNameTemplate || "ticket-{username}")}">
  <label>Panel message content</label><textarea name="panelContent">${escapeHtml(p.panelContent || "")}</textarea>
  <label>Questions (JSON array)</label><textarea name="questions" required>${escapeHtml(questions)}</textarea>
  <label>Panel embeds (JSON array)</label><textarea name="panelEmbeds">${escapeHtml(embeds)}</textarea>
  <label>Maximum open tickets per user</label><input type="number" min="1" max="10" name="maxOpenTickets" value="${p.maxOpenTickets || 1}">
  <button>Save panel</button></form></div>`, req);
}

function parseList(value) {
  return String(value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 5) {
    throw new Error("This version supports 1–5 questions per panel.");
  }

  for (const q of questions) {
    if (!q.label || typeof q.label !== "string" || q.label.length > 45) {
      throw new Error("Every question needs a label of 45 characters or fewer.");
    }

    if (!["short", "paragraph"].includes(q.style || "short")) {
      throw new Error("Question style must be short or paragraph.");
    }
  }
  return questions;
}

function parsePanelBody(body) {
  const questions = validateQuestions(JSON.parse(body.questions || "[]"));
  const embeds = JSON.parse(body.panelEmbeds || "[]");

  if (!Array.isArray(embeds) || embeds.length > 10) {
    throw new Error("Panel embeds must be a JSON array of at most 10 embeds.");
  }

  return {
    name: body.name.trim(),
    panelChannelId: body.panelChannelId.trim(),
    approvalChannelId: body.approvalChannelId.trim(),
    ticketCategoryId: body.ticketCategoryId.trim(),
    staffRoleIds: parseList(body.staffRoleIds),
    staffUserIds: parseList(body.staffUserIds),
    ticketNameTemplate: body.ticketNameTemplate || "ticket-{username}",
    panelContent: body.panelContent || "",
    questions,
    panelEmbeds: embeds,
    maxOpenTickets: Math.max(1, Math.min(10, Number(body.maxOpenTickets || 1)))
  };
}

router.post("/panels", requireLogin, async (req, res) => {
  try {
    const data = parsePanelBody(req.body);
    const panel = await Panel.create({
      ...data,
      guildId: process.env.DISCORD_GUILD_ID
    });

    await audit(panel.guildId, "dashboard", "panel_created", String(panel._id));
    res.redirect(`/panels/${panel._id}`);
  } catch (error) {
    res.status(400).send(page("Panel Error", `<p>${escapeHtml(error.message)}</p><a href="/panels/new">Back</a>`, req));
  }
});

router.get("/panels/:id", requireLogin, async (req, res) => {
  const panel = await Panel.findOne({
    _id: req.params.id,
    guildId: process.env.DISCORD_GUILD_ID
  }).lean();

  if (!panel) return res.status(404).send("Panel not found.");
  res.send(panelForm(req, panel));
});

router.post("/panels/:id", requireLogin, async (req, res) => {
  try {
    const data = parsePanelBody(req.body);
    const panel = await Panel.findOneAndUpdate(
      { _id: req.params.id, guildId: process.env.DISCORD_GUILD_ID },
      { $set: data },
      { new: true, runValidators: true }
    );

    if (!panel) return res.status(404).send("Panel not found.");
    await audit(panel.guildId, "dashboard", "panel_updated", String(panel._id));
    res.redirect("/panels");
  } catch (error) {
    res.status(400).send(page("Panel Error", `<p>${escapeHtml(error.message)}</p><a href="/panels">Back</a>`, req));
  }
});

router.post("/panels/:id/toggle", requireLogin, async (req, res) => {
  const panel = await Panel.findOne({
    _id: req.params.id,
    guildId: process.env.DISCORD_GUILD_ID
  });

  if (!panel) return res.status(404).send("Panel not found.");

  panel.enabled = !panel.enabled;
  await panel.save();
  await audit(panel.guildId, "dashboard", "panel_toggled", String(panel._id), { enabled: panel.enabled });
  res.redirect("/panels");
});

router.post("/panels/:id/publish", requireLogin, async (req, res) => {
  try {
    const panel = await Panel.findOne({
      _id: req.params.id,
      guildId: process.env.DISCORD_GUILD_ID
    });

    if (!panel) return res.status(404).send("Panel not found.");

    const client = req.app.locals.discordClient;
    const channel = await client.channels.fetch(panel.panelChannelId);

    if (!channel || !channel.isTextBased()) {
      throw new Error("The configured panel channel is unavailable.");
    }

    const message = await publishPanel(channel, panel);
    panel.panelMessageId = message.id;
    await panel.save();

    await audit(panel.guildId, "dashboard", "panel_published", String(panel._id));
    res.redirect("/panels");
  } catch (error) {
    res.status(400).send(page("Publish Error", `<p>${escapeHtml(error.message)}</p><a href="/panels">Back</a>`, req));
  }
});

router.get("/applications", requireLogin, async (req, res) => {
  const apps = await Application.find({
    guildId: process.env.DISCORD_GUILD_ID
  }).sort({ createdAt: -1 }).limit(100).lean();

  res.send(page("Applications", apps.map(a => `
    <div class="card">
    <strong>${escapeHtml(a.status)}</strong>
    <p>Applicant: ${escapeHtml(a.applicantId)}</p>
    <p>Application ID: ${a._id}</p>
    <p>Panel ID: ${a.panelId}</p>
    <p><small>${new Date(a.createdAt).toISOString()}</small></p>
    </div>`).join("") || "<p>No applications yet.</p>", req));
});

router.post("/uploads", requireLogin, (req, res, next) => {
  upload.single("image")(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!s3 || !process.env.S3_BUCKET || !process.env.S3_PUBLIC_BASE_URL) {
      return res.status(503).json({ error: "Persistent media storage is not configured." });
    }

    if (!req.file) return res.status(400).json({ error: "Select a PNG, JPG, WEBP or GIF file." });

    const extensions = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif"
    };

    const key = `uploads/${crypto.randomUUID()}.${extensions[req.file.mimetype]}`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    }));

    res.json({
      url: `${process.env.S3_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`,
      contentType: req.file.mimetype,
      size: req.file.size
    });
  } catch (error) {
    console.error("Upload failed:", error.message);
    res.status(500).json({ error: "Upload failed. Check storage configuration." });
  }
});

module.exports = { router };
