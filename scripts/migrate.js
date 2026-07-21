import { closePool, migrate } from "../src/db.js";

try {
  await migrate();
  console.log("Database schema is ready.");
} finally {
  await closePool();
}
