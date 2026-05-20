import { startAgentHubServer } from "./runtime.js";

startAgentHubServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
