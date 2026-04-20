import { db } from "@/server/db/client";
import { agentConfig } from "@/server/db/schema";
import { sql } from "drizzle-orm";
import { AGENTS, hashAgentConfig } from "./registry";

let synced = false;

/**
 * Upsert every agent in the registry into `agent_config`. Runs lazily on the
 * first call (typically from POST /tasks/:id/runs). The DB row is a cache —
 * the TS registry is the source of truth — but pinning a hash here lets us
 * surface "registry has drifted from the running snapshot" warnings later.
 */
export function syncAgentRegistry(): void {
  if (synced) return;
  synced = true;
  const now = new Date();
  db.transaction((tx) => {
    for (const a of Object.values(AGENTS)) {
      tx.insert(agentConfig)
        .values({
          id: a.id,
          name: a.name,
          promptTemplate: a.buildPrompt.toString(),
          skillHint: a.skillHint,
          model: a.model,
          maxTurns: a.maxTurns,
          configHash: hashAgentConfig(a),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: agentConfig.id,
          set: {
            name: a.name,
            promptTemplate: a.buildPrompt.toString(),
            skillHint: a.skillHint,
            model: a.model,
            maxTurns: a.maxTurns,
            configHash: hashAgentConfig(a),
            updatedAt: now,
          },
        })
        .run();
    }
  });
  // eslint-disable-next-line no-console
  console.log(`[agents] synced ${Object.keys(AGENTS).length} agent(s) to agent_config`);
  // Reference sql to silence unused-import warning in some configs.
  void sql;
}
