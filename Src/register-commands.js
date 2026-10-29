require("dotenv").config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");

async function main() {
  const required = [
    "DISCORD_TOKEN",
    "DISCORD_CLIENT_ID",
    "DISCORD_GUILD_ID"
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing ${key}`);
    }
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("ticket-status")
      .setDescription("Check AVENGED ticket system status"),

    new SlashCommandBuilder()
      .setName("ticket-publish")
      .setDescription("Publish an existing ticket panel")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(option =>
        option
          .setName("panel_id")
          .setDescription("MongoDB ID of the panel")
          .setRequired(true)
      )
  ].map(command => command.toJSON());

  const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.DISCORD_GUILD_ID
    ),
    { body: commands }
  );

  console.log(`Registered ${commands.length} guild commands.`);
}

main().catch(error => {
  console.error("Command registration failed:", error);
  process.exit(1);
});
