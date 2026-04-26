import "server-only";
import { z } from "zod";
import type { Ciphertext, Plaintext } from "@/server/lib/encryption";

// Per-service credential blobs stored in `user_prefs.credentials_json`.
//
// Two shapes per service:
//   - *Disk*: persisted form. Secret subfields are `Ciphertext` (the
//     `enc:v1:...` envelope produced by server/lib/encryption.ts).
//   - *Mem*:  decrypted in-memory form returned by readUserPrefs.
//             Secret subfields become `Plaintext`.
//
// Asymmetric types catch "forgot to encrypt before write" (or "forgot
// to decrypt after read") at compile time. Every block is `.strict()`
// — silent extra keys in a creds blob is exactly how secrets get
// smuggled.

export const SERVICE_KEYS = ["jira", "github", "git"] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];

const ciphertext = z
  .string()
  .startsWith("enc:v1:") as unknown as z.ZodType<Ciphertext>;
const plaintext = z.string().min(1) as unknown as z.ZodType<Plaintext>;

// ─── Jira ─────────────────────────────────────────────────────────────────────

export const JiraDisk = z
  .object({
    baseUrl: z.string().url(),
    email: z.string().email(),
    apiToken: ciphertext,
    // Populated from /rest/api/3/myself on Test Connection — used to
    // render "Connected as: <displayName> (<emailAddress>)" in /profile.
    displayName: z.string().optional(),
    accountId: z.string().optional(),
  })
  .strict();

export const JiraMem = JiraDisk.extend({ apiToken: plaintext });

export type JiraDisk = z.infer<typeof JiraDisk>;
export type JiraMem = z.infer<typeof JiraMem>;

// ─── GitHub ───────────────────────────────────────────────────────────────────

export const GithubDisk = z
  .object({
    token: ciphertext,
    // Populated from GET /user on Test Connection.
    login: z.string().optional(),
  })
  .strict();

export const GithubMem = GithubDisk.extend({ token: plaintext });

export type GithubDisk = z.infer<typeof GithubDisk>;
export type GithubMem = z.infer<typeof GithubMem>;

// ─── Git author identity ──────────────────────────────────────────────────────
//
// Non-secret. Used by the worker to set `git config --local
// user.name/user.email` in the worktree before any commit, so that
// commits (not just PRs) reflect the task creator. Same shape on disk
// and in memory.

export const GitIdentity = z
  .object({
    name: z.string().min(1).max(120),
    email: z.string().email(),
  })
  .strict();

export type GitIdentity = z.infer<typeof GitIdentity>;

// ─── Composite shapes ─────────────────────────────────────────────────────────

export const UserCredentialsDisk = z
  .object({
    jira: JiraDisk.optional(),
    github: GithubDisk.optional(),
    git: GitIdentity.optional(),
  })
  .strict();

export const UserCredentialsMem = z
  .object({
    jira: JiraMem.optional(),
    github: GithubMem.optional(),
    git: GitIdentity.optional(),
  })
  .strict();

export type UserCredentialsDisk = z.infer<typeof UserCredentialsDisk>;
export type UserCredentialsMem = z.infer<typeof UserCredentialsMem>;

// ─── Credential map by service ────────────────────────────────────────────────
//
// Used by the resolver's discriminated-union return shape so callers
// of `resolveCredentials<S>(userId, service)` get a precisely-typed
// `value` per service.

export type CredsFor<S extends ServiceKey> = S extends "jira"
  ? JiraMem
  : S extends "github"
    ? GithubMem
    : S extends "git"
      ? GitIdentity
      : never;
