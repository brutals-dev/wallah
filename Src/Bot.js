const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  AttachmentBuilder
} = require("discord.js");

const {
  Panel, Application, Ticket, audit
} = require("./database");

function staffAllowed(member, panel) {
  if (!member) return false;

  if (member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  return panel.staffUserIds.includes(member.id) ||
    panel.staffRoleIds.some(id => member.roles.cache.has(id));
}

function safeName(value) {
  return String(value || "user")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50) || "user";
}

function makeTranscript(messages, ticket) {
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  }[c]));

  const rows = messages.map(m => `
    <article>
      <strong>${escape(m.author?.tag || m.author?.username || "Unknown")}</strong>
      <time>${escape(m.createdAt?.toISOString?.() || "")}</time>
      <p>${escape(m.content || "[No text content]")}</p>
      ${(m.attachments || []).map(a =>
        `<p>Attachment: ${escape(a.name)} — ${escape(a.url)}</p>`
      ).join("")}
    </article>
  `).join("\n");

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>AVENGED Ticket Transcript</title>
<style>
body{font-family:Arial,sans-serif;max-width:900px;margin:30px auto;padding:16px;background:#151515;color:#eee}
article{padding:12px;margin:12px 0;background:#242424;border-left:4px solid #c83232;overflow-wrap:anywhere}
time{display:block;color:#aaa;font-size:12px}p{white-space:pre-wrap}
</style></head><body>
<h1>AVENGED Ticket Transcript</h1>
<p>Ticket: ${escape(ticket._id)}</p>
${rows}
</body></html>`;

  const txt = messages.map(m =>
    `[${m.createdAt?.toISOString?.() || ""}] ${m.author?.tag || m.author?.username || "Unknown"}: ${m.content || "[No text content]"}\n` +
    (m.attachments || []).map(a => `Attachment: ${a.name} ${a.url}`).join("\n")
  ).join("\n\n");

  return { html, txt };
}

async function getTranscript(channel, ticket) {
  const all = [];
  let before;

  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });

    if (!batch.size) break;

    all.push(...batch.values());
    before = batch.last().id;

    if (all.length >= 5000) break;
  }

  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return makeTranscript(all, ticket);
}

async function sendTranscriptDM(client, ticket, panel, channel, reason) {
  const { html, txt } = await getTranscript(channel, ticket);

  const htmlFile = new AttachmentBuilder(
    Buffer.from(html, "utf8"),
    { name: `AV-${ticket._id}-transcript.html` }
  );

  const txtFile = new AttachmentBuilder(
    Buffer.from(txt, "utf8"),
    { name: `AV-${ticket._id}-transcript.txt` }
  );

  const embed = new EmbedBuilder()
    .setColor(0xc83232)
    .setTitle("AVENGED | TICKET CLOSED")
    .setDescription("Your ticket has been closed. Your conversation transcript is attached.")
    .addFields(
      { name: "Panel", value: panel.name, inline: true },
      { name: "Ticket ID", value: String(ticket._id), inline: true },
      { name: "Reason", value: reason || "No reason provided" }
    )
    .setTimestamp();

  try {
    const user = await client.users.fetch(ticket.applicantId);
    await user.send({
      embeds: [embed],
      files: [htmlFile, txtFile]
    });

    return true;
  } catch (error) {
    console.error("Transcript DM failed:", error.message);
    return false;
  }
}

async function fetchPanel(interaction, panelId) {
  return Panel.findOne({
    _id: panelId,
    guildId: interaction.guildId
  });
}

async function createTicket(interaction, application, panel, client) {
  const guild = interaction.guild;
  const member = await guild.members.fetch(application.applicantId);

  const activeCount = await Ticket.countDocuments({
    guildId: guild.id,
    applicantId: application.applicantId,
    status: "open",
    panelId: panel._id
  });

  if (activeCount >= panel.maxOpenTickets) {
    throw new Error("Applicant has reached the open ticket limit");
  }

  const name = (panel.ticketNameTemplate || "ticket-{username}")
    .replaceAll("{username}", safeName(member.user.username))
    .replaceAll("{userid}", member.id)
    .replaceAll("{panel}", safeName(panel.name))
    .slice(0, 90);

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    }
  ];

  for (const roleId of panel.staffRoleIds) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: panel.ticketCategoryId,
    permissionOverwrites: overwrites,
    reason: `Approved AVENGED application ${application._id}`
  });

  try {
    const ticket = await Ticket.create({
      guildId: guild.id,
      panelId: panel._id,
      applicationId: application._id,
      applicantId: application.applicantId,
      channelId: channel.id,
      status: "open"
    });

    const embed = new EmbedBuilder()
      .setColor(0xc83232)
      .setTitle(`AVENGED | ${panel.name}`)
      .setDescription("Your application has been approved. Staff will assist you here.")
      .addFields(
        { name: "Ticket ID", value: String(ticket._id) },
        ...application.answers.map(a => ({
          name: String(a.label).slice(0, 256),
          value: String(a.value || "Not provided").slice(0, 1024)
        })).slice(0, 20)
      )
      .setTimestamp();

    const controls = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:claim:${ticket._id}`).setLabel("Claim").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ticket:close:${ticket._id}`).setLabel("Close").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ticket:reopen:${ticket._id}`).setLabel("Reopen").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ticket:delete:${ticket._id}`).setLabel("Delete").setStyle(ButtonStyle.Danger)
    );

    await channel.send({
      content: `<@${member.id}>`,
      embeds: [embed],
      components: [controls],
      allowedMentions: { users: [member.id] }
    });

    await Application.updateOne(
      { _id: application._id, status: "pending" },
      {
        $set: {
          status: "approved",
          reviewerId: interaction.user.id,
          reviewedAt: new Date(),
          ticketChannelId: channel.id
        }
      }
    );

    await audit(guild.id, interaction.user.id, "ticket_created", String(ticket._id), {
      channelId: channel.id
    });

    return { channel, ticket };
  } catch (error) {
    await channel.delete("Rolling back failed ticket creation").catch(() => {});
    throw error;
  }
}

async function handleButton(interaction, client) {
  const [type, action, id] = interaction.customId.split(":");

  if (type === "panel" && action === "open") {
    const panel = await fetchPanel(interaction, id);

    if (!panel || !panel.enabled) {
      return interaction.reply({ content: "This panel is unavailable.", ephemeral: true });
    }

    const questions = panel.questions || [];
    if (!questions.length) {
      return interaction.reply({ content: "This panel has no questions configured.", ephemeral: true });
    }

    if (questions.length > 5) {
      return interaction.reply({
        content: "This form needs multiple steps. Configure five or fewer questions until multi-step forms are enabled.",
        ephemeral: true
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(`apply:${panel._id}`)
      .setTitle(panel.name.slice(0, 45));

    modal.addComponents(...questions.map((q, i) =>
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`q${i}`)
          .setLabel(String(q.label).slice(0, 45))
          .setPlaceholder(String(q.placeholder || "").slice(0, 100))
          .setStyle(q.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(q.required !== false)
          .setMaxLength(Math.min(Math.max(q.maxLength || 300, 1), 4000))
      )
    ));

    return interaction.showModal(modal);
  }

  if (type === "approval") {
    const application = await Application.findById(id);
    if (!application) {
      return interaction.reply({ content: "Application not found.", ephemeral: true });
    }

    const panel = await Panel.findById(application.panelId);
    if (!panel || !staffAllowed(interaction.member, panel)) {
      return interaction.reply({ content: "You are not authorised to review this application.", ephemeral: true });
    }

    if (application.status !== "pending") {
      return interaction.reply({ content: "This application has already been reviewed.", ephemeral: true });
    }

    if (action === "reject") {
      const result = await Application.updateOne(
        { _id: id, status: "pending" },
        {
          $set: {
            status: "rejected",
            reviewerId: interaction.user.id,
            reviewedAt: new Date()
          }
        }
      );

      if (!result.modifiedCount) {
        return interaction.reply({ content: "Another staff member already reviewed this application.", ephemeral: true });
      }

      await interaction.update({ content: `Rejected by ${interaction.user.tag}.`, components: [] });

      if (panel.notifyOnReject) {
        const user = await client.users.fetch(application.applicantId).catch(() => null);
        if (user) await user.send(`Your ${panel.name} application was rejected.`).catch(() => {});
      }

      await audit(interaction.guildId, interaction.user.id, "application_rejected", id);
      return;
    }

    if (action === "approve") {
      const result = await Application.updateOne(
        { _id: id, status: "pending" },
        {
          $set: {
            status: "failed",
            reviewerId: interaction.user.id,
            reviewedAt: new Date(),
            error: "Ticket creation in progress"
          }
        }
      );

      if (!result.modifiedCount) {
        return interaction.reply({ content: "Another staff member already reviewed this application.", ephemeral: true });
      }

      await interaction.deferUpdate();

      try {
        const { channel } = await createTicket(interaction, application, panel, client);

        await interaction.message.edit({
          content: `Approved by ${interaction.user.tag} — ticket created: ${channel}`,
          components: []
        });

        const user = await client.users.fetch(application.applicantId).catch(() => null);
        if (user) {
          await user.send(`Your ${panel.name} application has been approved. Your ticket is in ${interaction.guild.name}.`).catch(() => {});
        }
      } catch (error) {
        await Application.updateOne(
          { _id: id, status: "failed" },
          { $set: { error: error.message } }
        );

        await interaction.followUp({
          content: `Ticket creation failed: ${error.message}. The application is marked failed and needs a safe retry.`,
          ephemeral: true
        });
      }
    }

    return;
  }

  if (type === "ticket") {
    const ticket = await Ticket.findById(id);
    if (!ticket) {
      return interaction.reply({ content: "Ticket record not found.", ephemeral: true });
    }

    const panel = await Panel.findById(ticket.panelId);
    if (!panel || !staffAllowed(interaction.member, panel)) {
      return interaction.reply({ content: "Only authorised staff can use this control.", ephemeral: true });
    }

    const channel = interaction.guild.channels.cache.get(ticket.channelId);
    if (!channel) {
      return interaction.reply({ content: "Ticket channel no longer exists.", ephemeral: true });
    }

    if (action === "claim") {
      if (ticket.status !== "open") {
        return interaction.reply({ content: "Only open tickets can be claimed.", ephemeral: true });
      }

      ticket.claimedBy = interaction.user.id;
      await ticket.save();
      await audit(ticket.guildId, interaction.user.id, "ticket_claimed", id);
      return interaction.reply({ content: `Ticket claimed by ${interaction.user}.`, allowedMentions: { users: [interaction.user.id] } });
    }

    if (action === "close") {
      if (ticket.status !== "open") {
        return interaction.reply({ content: "This ticket is not open.", ephemeral: true });
      }

      ticket.status = "closed";
      ticket.closedBy = interaction.user.id;
      ticket.closedAt = new Date();
      await ticket.save();

      await channel.permissionOverwrites.edit(ticket.applicantId, {
        SendMessages: false
      }).catch(() => {});

      const dmSent = await sendTranscriptDM(client, ticket, panel, channel, ticket.closeReason);

      await audit(ticket.guildId, interaction.user.id, "ticket_closed", id, { dmSent });
      return interaction.reply({
        content: dmSent
          ? "Ticket closed. Transcript sent to the opener's DMs."
          : "Ticket closed. Transcript DM failed; check logs and the ticket record.",
        ephemeral: true
      });
    }

    if (action === "reopen") {
      if (!panel.allowReopen || ticket.status !== "closed") {
        return interaction.reply({ content: "This ticket cannot be reopened.", ephemeral: true });
      }

      ticket.status = "open";
      ticket.reopenedAt = new Date();
      await ticket.save();

      await channel.permissionOverwrites.edit(ticket.applicantId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });

      await audit(ticket.guildId, interaction.user.id, "ticket_reopened", id);
      return interaction.reply({ content: "Ticket reopened.", ephemeral: true });
    }

    if (action === "delete") {
      if (ticket.status === "open") {
        return interaction.reply({ content: "Close the ticket before deleting it.", ephemeral: true });
      }

      await sendTranscriptDM(client, ticket, panel, channel, ticket.closeReason).catch(() => false);

      ticket.status = "deleted";
      ticket.deletedAt = new Date();
      await ticket.save();

      await audit(ticket.guildId, interaction.user.id, "ticket_deleted", id);
      await interaction.reply({ content: "Ticket record saved. Deleting channel…", ephemeral: true });
      await channel.delete("Ticket deleted by authorised staff");
    }
  }
}

async function handleModal(interaction) {
  if (!interaction.customId.startsWith("apply:")) return;

  const panelId = interaction.customId.split(":")[1];
  const panel = await Panel.findOne({
    _id: panelId,
    guildId: interaction.guildId,
    enabled: true
  });

  if (!panel) {
    return interaction.reply({ content: "This panel is unavailable.", ephemeral: true });
  }

  const answers = panel.questions.map((q, i) => ({
    label: q.label,
    value: interaction.fields.getTextInputValue(`q${i}`)
  }));

  const application = await Application.create({
    guildId: interaction.guildId,
    panelId: panel._id,
    applicantId: interaction.user.id,
    answers
  });

  const reviewChannel = await interaction.guild.channels.fetch(panel.approvalChannelId);

  const embed = new EmbedBuilder()
    .setColor(0xc83232)
    .setTitle(`APPLICATION | ${panel.name}`)
    .setDescription(`Applicant: ${interaction.user.tag}\nID: ${interaction.user.id}\nApplication: ${application._id}`)
    .addFields(answers.map(a => ({
      name: a.label.slice(0, 256),
      value: a.value.slice(0, 1024) || "Not provided"
    })).slice(0, 25))
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approval:approve:${application._id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`approval:reject:${application._id}`).setLabel("Reject").setStyle(ButtonStyle.Danger)
  );

  const reviewMessage = await reviewChannel.send({
    embeds: [embed],
    components: [buttons],
    allowedMentions: { parse: [] }
  });

  application.reviewMessageId = reviewMessage.id;
  application.reviewChannelId = reviewChannel.id;
  await application.save();

  await audit(interaction.guildId, interaction.user.id, "application_submitted", String(application._id));

  return interaction.reply({
    content: "Your application has been submitted for staff review. No ticket has been created yet.",
    ephemeral: true
  });
}

async function publishPanel(channel, panel) {
  const embed = new EmbedBuilder()
    .setColor(0xc83232)
    .setTitle(panel.name)
    .setDescription("Select the button below to submit an application.");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`panel:open:${panel._id}`)
      .setLabel(`Open ${panel.name}`.slice(0, 80))
      .setStyle(ButtonStyle.Primary)
  );

  return channel.send({
    content: panel.panelContent || "",
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [] }
  });
}

function registerBotHandlers(client) {
  client.on("interactionCreate", async interaction => {
    try {
      if (interaction.isButton()) {
        await handleButton(interaction, client);
      } else if (interaction.isModalSubmit()) {
        await handleModal(interaction);
      } else if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "ticket-status") {
          const [panels, pending, tickets] = await Promise.all([
            Panel.countDocuments({ guildId: interaction.guildId }),
            Application.countDocuments({ guildId: interaction.guildId, status: "pending" }),
            Ticket.countDocuments({ guildId: interaction.guildId, status: "open" })
          ]);

          await interaction.reply({
            content: `Panels: ${panels}\nPending applications: ${pending}\nOpen tickets: ${tickets}`,
            ephemeral: true
          });
        } else if (interaction.commandName === "ticket-publish") {
          if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: "Manage Server permission required.", ephemeral: true });
          }

          const panelId = interaction.options.getString("panel_id", true);
          const panel = await Panel.findOne({ _id: panelId, guildId: interaction.guildId });

          if (!panel) {
            return interaction.reply({ content: "Panel not found.", ephemeral: true });
          }

          const message = await publishPanel(interaction.channel, panel);
          panel.panelChannelId = interaction.channelId;
          panel.panelMessageId = message.id;
          await panel.save();

          await interaction.reply({ content: "Panel published.", ephemeral: true });
        }
      }
    } catch (error) {
      console.error("Interaction error:", error);

      const response = {
        content: "Something went wrong. Check the bot logs or ask an administrator.",
        ephemeral: true
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(response).catch(() => {});
      } else {
        await interaction.reply(response).catch(() => {});
      }
    }
  });
}

module.exports = { registerBotHandlers, publishPanel };
