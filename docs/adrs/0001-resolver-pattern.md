# ADR 0001 — Per-User Resolver Pattern

- Status: accepted
- Date: 2026-04-26
- Drivers: per-user agent overrides (shipped, Phase 4 sidebar work),
  per-user tokens (`docs/plans/2026-04-26-feat-per-user-tokens-with-instance-fallback-plan.md`),
  per-user workflow overrides (future, see `docs/plans/2026-04-24-feat-customizable-workflow-v1-plan.md`).

## Context

Several features overlay per-user preferences on top of instance-wide
defaults: agent overrides today (`AGENT_OVERRIDES` settings key →
`getAgent(id, {userId})` resolver), per-user tokens next, and likely
per-user workflow / Anthropic key / notification preferences after.

Without a shared contract every feature reinvents the resolver shape:
function name, return type, source-tracking, failure mode, lazy import
strategy. The result is fragmentation — readers have to learn each
resolver from scratch and writers copy-paste subtly different
patterns. This ADR pins the contract.

## Decision

Every per-user resolver follows this shape:

### 1. Lookup order

1. **User overlay** — `user_prefs` JSON column for that userId, parsed
   and validated via zod.
2. **Instance default** — `getConfig(KEY)` for the corresponding
   `settings` row (or `process.env`, via the existing precedence
   chain).
3. **Type-level fallback** — a code-shipped baseline (e.g. base agent
   config in `AGENTS`) or `null` / `'missing'` for the calling code
   to handle.

### 2. Return shape

Resolvers return a **discriminated union** that explicitly names the
source. Callers cannot accidentally treat a missing value as present:

```typescript
type ResolverResult<T> =
  | { source: 'user' | 'instance'; value: T }
  | { source: 'missing'; value: null };
```

Fields that fall back transitively (e.g. agent config: user overlay →
instance overlay → code-shipped base) collapse `'missing'` to the
typed default and report the highest-priority source actually used.

### 3. Lazy require to break import cycles

Resolvers live downstream of `getConfig` and `userPrefs.ts`, both of
which depend on `db/client`, which depends on `lib/env`. To avoid
load-time cycles, resolver modules use `require()` for their
dependencies inside the function body:

```typescript
export function resolveCredentials<S extends ServiceKey>(
  userId: string | null,
  service: S,
): ResolvedCreds<S> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getConfig } = require("@/server/lib/config") as typeof import("@/server/lib/config");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readUserPrefs } = require("@/server/lib/userPrefs") as typeof import("@/server/lib/userPrefs");
  // ...
}
```

This is the same pattern already used by `getAgent` at
`server/agents/registry.ts:743-806`. New resolvers must follow it.

### 4. Failure-mode contract

- **No row in `user_prefs`** → silently fall through to instance.
  Returning a non-existent user's profile is a feature, not an error.
- **Malformed JSON in user_prefs** → `safeParse` returns the schema's
  defaults; audit `<resolver>.parse_failure{userId}`; fall through to
  instance. Never throw.
- **Decryption failure** (for credential/secret resolvers) → audit
  `<resolver>.decrypt_failure{userId, fieldPath}`; fall through to
  instance for that field; banner the user on next /profile load.
- **Instance default also missing** → return `'missing'` source with
  `null` value. The caller decides whether to fail-fast at run start
  (`credentials_not_configured`), use a code-shipped base
  (`getAgent`), or handle inline.

### 5. Source tracking for audit

When a resolver result is consumed by a long-lived operation (a run,
a scheduled job), the consumer **records the source** alongside the
operation's persisted state — typically as a flat column, not a
JSON blob, so the audit query is `WHERE source_column = 'instance'`.

Example: `runs.jira_token_source` and `runs.github_token_source`
flat columns enable cheap indexed queries for "users relying on
instance fallback this week," which the per-user-tokens plan needs
for the privilege-escalation visibility mitigation.

## Consequences

- New resolvers for any per-user feature can copy the shape
  mechanically.
- Reviewers have a single rubric to check resolvers against:
  discriminated union; lazy-require; safeParse-with-fallback;
  source-tracking column on the consuming row.
- The pattern is **not** appropriate for resolvers that need to
  cross-check with external systems on every call (e.g. live API key
  validation). That's a separate concern; see the per-user-tokens
  plan's "test-before-save" flow which is a one-shot validation, not
  a per-call resolver step.

## References

- `getAgent(id, {userId})` — `server/agents/registry.ts:743-806`
- `readUserPrefs(userId)` — `server/lib/userPrefs.ts:49-67`
- Per-user tokens plan — `docs/plans/2026-04-26-feat-per-user-tokens-with-instance-fallback-plan.md`
- Customizable workflow v1 plan — `docs/plans/2026-04-24-feat-customizable-workflow-v1-plan.md`
