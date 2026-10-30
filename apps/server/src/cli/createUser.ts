import { closeAllDbs, config } from "@regreview/core";
import { createUser, ensureAuthIndexes } from "../auth.js";

/**
 * Seed a reviewer account into Mongo (or, with REGREVIEW_LOCAL=1, into the
 * local accounts database).
 *
 * There is no self-serve signup — accounts are created by whoever runs the
 * deployment, the same way REGREVIEW_AUTH_USER/PASSWORD used to be set by
 * hand. Usage: npm run user:create -- <username> <password>
 */
const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error("Usage: npm run user:create -- <username> <password>");
  process.exit(1);
}

if (!config.local && !process.env["MONGODB_URI"]) {
  console.error("MONGODB_URI is not set (or set REGREVIEW_LOCAL=1 for a local account).");
  process.exit(1);
}

await ensureAuthIndexes();
try {
  await createUser(username, password);
  console.log(`Created user "${username}"${config.local ? " (local)" : ""}.`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("E11000")) {
    console.error(`A user named "${username}" already exists.`);
  } else {
    console.error(message);
  }
  process.exitCode = 1;
}
// Close before exiting: the local databases checkpoint to disk on close.
await closeAllDbs();
process.exit(process.exitCode ?? 0);
