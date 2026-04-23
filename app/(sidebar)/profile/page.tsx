import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { AGENTS } from "@/server/agents/registry";
import { readUserPrefs } from "@/server/lib/userPrefs";
import { IdentitySection } from "@/components/profile/IdentitySection";
import { AgentDefaultsSection } from "@/components/profile/AgentDefaultsSection";
import { NotificationPrefsSection } from "@/components/profile/NotificationPrefsSection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL_OPTIONS = [
  { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export default async function ProfilePage() {
  const session = await auth();
  const user = session?.user as
    | { id?: string; email?: string; name?: string }
    | undefined;
  if (!user?.id) redirect("/sign-in");

  // Always re-read the DB row so the name is fresh after a recent save.
  const row = db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, user.id))
    .get();

  const prefs = readUserPrefs(user.id);

  // Build a representative sample prompt for each agent so the Profile
  // UI can show operators exactly what the agent reads. Placeholders are
  // filled with stub values; an "Operator notes" section is appended at
  // runtime if they set promptAppend — so the prompt they see here is
  // the FLOOR of what the agent receives.
  const SAMPLE_CTX = {
    jiraKey: "DEMO-1234",
    title: "Sample ticket title",
    description:
      "This is a sample ticket description used to preview the agent's built-in prompt.",
    priorArtifacts: [] as Array<{ kind: string; markdown: string }>,
    recentCommits: "abc1234 feat: sample commit\ndef5678 fix: another sample",
    priorReviewCount: 0,
    cwd: "/path/to/worktree",
  };

  const agents = Object.values(AGENTS).map((a) => {
    let basePrompt = "";
    try {
      basePrompt = a.buildPrompt(SAMPLE_CTX as never);
    } catch {
      basePrompt = "(failed to render sample prompt)";
    }
    return {
      id: a.id,
      label: a.name,
      instanceModel: a.model,
      instanceCostWarnUsd:
        "costWarnUsd" in a && typeof a.costWarnUsd === "number"
          ? a.costWarnUsd
          : 10,
      instanceCostKillUsd:
        "costKillUsd" in a && typeof a.costKillUsd === "number"
          ? a.costKillUsd
          : 30,
      basePrompt,
    };
  });

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
          profile
        </div>
        <h1 className="text-xl font-semibold">Your settings</h1>
        <p className="mt-1 text-sm text-[color:var(--muted)]">
          Personal preferences that follow you across the orchestrator.
          Instance-wide settings (Jira, OAuth, paths) live in{" "}
          <span className="font-mono">/admin/settings</span>.
        </p>
      </header>

      <div className="space-y-4">
        <IdentitySection
          initialName={row?.name ?? ""}
          email={row?.email ?? user.email ?? ""}
        />
        <AgentDefaultsSection
          agents={agents}
          initial={prefs.agentOverrides}
          models={MODEL_OPTIONS}
        />
        <NotificationPrefsSection initial={prefs.notifications} />
      </div>
    </div>
  );
}
