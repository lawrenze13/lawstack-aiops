import { NextResponse } from "next/server";
import { auth } from "@/server/auth/config";
import { listNotifications, type ViewerScope } from "@/server/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  const user = session?.user as { id?: string; role?: string } | undefined;
  if (!user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const scope: ViewerScope = {
    userId: user.id,
    role: (user.role ?? "member") as ViewerScope["role"],
  };
  const items = listNotifications(scope, 50);
  return NextResponse.json({ items });
}
