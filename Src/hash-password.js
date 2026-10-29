const bcrypt = require("bcrypt");
const readline = require("node:readline/promises");

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const password = process.argv[2] ||
      await rl.question("Enter dashboard password: ");

    if (!password || password.length < 12) {
      throw new Error("Use a password with at least 12 characters.");
    }

    const hash = await bcrypt.hash(password, 12);

    console.log("\nCopy this hash into DASHBOARD_PASSWORD_HASH in Railway:");
    console.log(hash);
  } finally {
    rl.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
