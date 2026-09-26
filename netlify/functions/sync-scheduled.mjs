// Pulls new card and bank transactions every 3 hours, even when the app is closed.
import { syncAll } from "../lib/budget.mjs";

export default async () => {
  const r = await syncAll();
  console.log("Scheduled sync", { added: r.added, modified: r.modified, removed: r.removed });
};

export const config = { schedule: "0 */3 * * *" };
