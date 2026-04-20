import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth/config";
import { AppError, Unauthorized } from "./errors";

type Handler<T> = (ctx: {
  req: Request;
  user: { id: string; email: string; role: string };
}) => Promise<T>;

/**
 * Wraps a route handler with: session check, error-to-JSON mapping, Zod parse
 * error normalisation. Use for every authenticated route.
 */
export function withAuth<T>(handler: Handler<T>) {
  return async (req: Request): Promise<Response> => {
    try {
      const session = await auth();
      const u = session?.user as
        | { id?: string; email?: string | null; role?: string }
        | undefined;
      if (!u?.id || !u.email) throw new Unauthorized("not signed in");
      const result = await handler({
        req,
        user: { id: u.id, email: u.email, role: u.role ?? "member" },
      });
      return NextResponse.json(result);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function errorResponse(err: unknown): Response {
  if (err instanceof z.ZodError) {
    return NextResponse.json(
      { error: "validation_error", issues: err.flatten() },
      { status: 400 },
    );
  }
  if (err instanceof AppError) {
    return NextResponse.json({ error: err.name, message: err.message }, { status: err.status });
  }
  // eslint-disable-next-line no-console
  console.error("unhandled route error", err);
  return NextResponse.json(
    { error: "internal_error", message: "unexpected error" },
    { status: 500 },
  );
}
