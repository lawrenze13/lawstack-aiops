import { NextResponse } from "next/server";
import { authEdge } from "@/server/auth/edge";

// Gates everything except the auth endpoints, the sign-in page, static
// assets, and the Next internals. Unauthenticated requests to API routes
// return 401 JSON; page requests redirect to /sign-in.
//
// Uses the edge-safe config (no DB adapter import) so middleware can run
// on the Edge runtime. Full session callbacks live in route handlers via
// auth() from server/auth/config.
export default authEdge((req) => {
  const { pathname } = req.nextUrl;

  const isAuthRoute = pathname.startsWith("/api/auth");
  const isSignIn = pathname === "/sign-in";
  if (isAuthRoute || isSignIn) return NextResponse.next();

  if (!req.auth) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/sign-in";
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
});

export const config = {
  // Skip Next.js internals + common static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico)).*)"],
};
