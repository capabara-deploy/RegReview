import { createUser, ensureAuthIndexes } from "../auth.js";

/**
 * Seed a reviewer account into Mongo.
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

if (!process.env["MONGODB_URI"]) {
  console.error("MONGODB_URI is not set.");
  process.exit(1);
}

await ensureAuthIndexes();
try {
  await createUser(username, password);
  console.log(`Created user "${username}".`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("E11000")) {
    console.error(`A user named "${username}" already exists.`);
  } else {
    console.error(message);
  }
  process.exit(1);
}
process.exit(0);
