require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const { Client, GatewayIntentBits, Events } = require("discord.js");
const { connectDatabase, mongoose } = require("./database");
const { registerBotHandlers } = require("./bot");
const { router } = require("./dashboard");

async function main() {
  const required = [
    "DISCORD_TOKEN",
    "DISCORD_CLIENT_ID",
    "DISCORD_GUILD_ID",
    "MONGODB_URI",
    "DASHBOARD_USERNAME",
    "DASHBOARD_PASSWORD_HASH",
    "SESSION_SECRET"
  ];

  const missing = required.filter(key => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }

  await connectDatabase();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers
    ]
  });

  registerBotHandlers(client);

  client.once(Events.ClientReady, readyClient => {
    console.log(`Discord bot ready: ${readyClient.user.tag}`);
  });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet({
    contentSecurityPolicy: false
  }));

  app.get("/health", (req, res) => {
    const dbReady = mongoose.connection.readyState === 1;

    res.status(dbReady && client.isReady() ? 200 : 503).json({
      ok: dbReady && client.isReady(),
      botReady: client.isReady(),
      dbState: mongoose.connection.readyState
    });
  });

  app.locals.discordClient = client;
  app.use("/", router);

  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Dashboard listening on port ${port}`);
  });

  await client.login(process.env.DISCORD_TOKEN);

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Received ${signal}; shutting down`);

    server.close();
    client.destroy();
    await mongoose.disconnect().catch(console.error);

    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});
