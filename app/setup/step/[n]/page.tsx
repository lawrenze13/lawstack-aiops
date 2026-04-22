import { notFound, redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { SETTINGS } from "@/server/lib/settingsSchema";
import { validateSetupToken } from "@/server/auth/setupToken";
import { getConfig } from "@/server/lib/config";
import { WizardStep } from "@/components/setup/WizardStep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ n: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * /setup/step/[n] — renders the nth section of the wizard.
 *
 * Ordered by SETTINGS[i].wizardOrder. 1-indexed for the URL so
 * bookmarks read naturally ("step 1 of 6").
 */
export default async function WizardStepPage({ params, searchParams }: Props) {
  const { n } = await params;
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";

  // Guard: if setup is already complete, bounce to /sign-in.
  const anyUser = db.select({ id: users.id }).from(users).limit(1).all();
  if (anyUser.length > 0) redirect("/sign-in");

  if (!validateSetupToken(token)) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-700">
        Setup token invalid or expired. Open the URL from your server's
        stdout.
      </div>
    );
  }

  const stepNumber = Number.parseInt(n, 10);
  if (!Number.isFinite(stepNumber) || stepNumber < 1) notFound();

  const orderedSections = [...SETTINGS].sort(
    (a, b) => a.wizardOrder - b.wizardOrder,
  );
  const section = orderedSections[stepNumber - 1];
  if (!section) notFound();

  // Seed current values from the settings table (e.g. if the user ran the
  // wizard partially and came back).
  const initialValues: Record<string, unknown> = {};
  for (const field of section.fields) {
    try {
      initialValues[field.key] = getConfig(
        field.key as never,
        { skipCache: true },
      );
    } catch {
      initialValues[field.key] = null;
    }
  }

  return (
    <WizardStep
      token={token}
      stepNumber={stepNumber}
      totalSteps={orderedSections.length}
      section={section}
      initialValues={initialValues}
    />
  );
}
