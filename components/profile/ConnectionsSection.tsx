import { JiraConnectionCard, type JiraInitial } from "./JiraConnectionCard";
import { GithubConnectionCard, type GithubInitial } from "./GithubConnectionCard";
import { GitIdentityCard, type GitIdentityInitial } from "./GitIdentityCard";

type Props = {
  jira: JiraInitial;
  github: GithubInitial;
  git: GitIdentityInitial;
  defaultGitName: string;
  defaultGitEmail: string;
};

/**
 * /profile "Connections" section. Wraps the three credential cards
 * with a section heading. Server component — composition only; the
 * cards themselves are client components for interactivity.
 */
export function ConnectionsSection(props: Props) {
  return (
    <div className="space-y-4">
      <header className="px-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
          profile · connections
        </div>
        <h2 className="mt-1 text-sm font-semibold">External services</h2>
        <p className="mt-1 text-xs text-[color:var(--muted)]">
          Configure your own Jira + GitHub credentials so runs you start use
          your identity. Leave blank to fall back to the instance defaults
          set by your admin in{" "}
          <span className="font-mono">/admin/settings</span>.
        </p>
      </header>
      <JiraConnectionCard initial={props.jira} />
      <GithubConnectionCard initial={props.github} />
      <GitIdentityCard
        initial={props.git}
        defaultName={props.defaultGitName}
        defaultEmail={props.defaultGitEmail}
      />
    </div>
  );
}
