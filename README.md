# AVENGED Ticket Bot

Custom Discord ticket bot built with Discord.js v14, Express and MongoDB.

## Requirements

- Node.js 20 or newer
- Discord application and bot token
- MongoDB Atlas database
- Railway deployment
- S3-compatible object storage for uploaded media

## Local setup

1. Clone the repository.
2. Install dependencies:

   npm install

3. Copy `.env.example` to `.env`.
4. Fill in the environment variables privately.
5. Check JavaScript syntax:

   npm run check

6. Register Discord slash commands:

   npm run commands:register

7. Start the application:

   npm start

## Railway setup

1. Push the source files to a private GitHub repository.
2. Deploy the repository on Railway.
3. Configure the required environment variables.
4. Generate a public HTTPS domain.
5. Set BASE_URL to that domain.
6. Check /health after deployment.

## Security

- Never commit `.env`.
- Never publish bot or database credentials.
- Grant the bot only the permissions it needs.
- Test permissions and ticket actions in a private test server.
- Keep the MongoDB database and storage credentials secure.

## Current limitations

This source is a development foundation and has not been
verified against a live Discord server.

The dashboard currently supports basic panel creation,
editing, enable/disable, publishing, application listing,
and authenticated image uploads.

Further work is required for a complete production release:
full embed builder, multi-step forms, panel duplication and
deletion, rejection reasons, robust retry processing,
complete transcript logging, configurable ticket controls,
Discord OAuth2 authentication, and comprehensive tests.

Do not use this version as a production-ready replacement
until these features are implemented and tested.
