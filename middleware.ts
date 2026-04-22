import { NextResponse } from "next/server";
import { authEdge } from "@/server/auth/edge";

// Gates everything except the auth endpoints, the sign-in page, the setup
// wizard (during first-run bootstrap), static assets, and Next internals.
// Unauthenticated API calls return 401; unauthenticated page requests
// redirect to /sign-in.
//
// Edge-safe: no DB access here. Token validation for /setup* runs in the
// route handlers (which are Node runtime). Middleware's job is only to
// let those paths *through* to their handlers. The handlers then call
// `validateSetupToken(token)` from server/auth/setupToken.ts.
export default authEdge((req) => {
  const { pathname } = req.nextUrl;

  const isAuthRoute = pathname.startsWith("/api/auth");
  const isSignIn = pathname === "/sign-in";
  // Allow setup routes through unauthenticated — the route handler validates
  // the ?token= against the setup_tokens table and returns 403 if missing
  // or if an admin user already exists.
  const isSetup =
    pathname === "/setup" ||
    pathname.startsWith("/setup/") ||
    pathname.startsWith("/api/setup/");
  const isHealth = pathname === "/api/health";

  if (isAuthRoute || isSignIn || isSetup || isHealth) return NextResponse.next();

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
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico)).*)"],
};
