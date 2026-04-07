import { Issue, TrackerClient, TrackerConfig } from "./types";
import { normalizeLowercase } from "./string-utils";
import { CommandRunner, ShellCommandRunner } from "./process";

/**
 * Linear CLI-based tracker client.
 *
 * Uses the `linear` CLI (https://github.com/schpet/linear-cli) instead of
 * hitting the Linear GraphQL API directly. Every interaction is a shell command.
 */

function parseJsonSafely<T>(raw: string): T | null {
  try {
    return JSON.parse(raw.trim()) as T;
  } catch {
    return null;
  }
}

interface LinearCliIssue {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  state?: { name?: string } | string;
  priority?: number;
  labels?: Array<{ name?: string }> | string[];
  assignee?: { id?: string; name?: string } | string;
  creator?: { id?: string } | string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
}

function extractStateName(state: unknown): string {
  if (!state) return "";
  if (typeof state === "string") return state;
  if (typeof state === "object" && state !== null && "name" in state) {
    return String((state as Record<string, unknown>).name ?? "");
  }
  return "";
}

function extractId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value || null;
  if (typeof value === "object" && value !== null && "id" in value) {
    return String((value as Record<string, unknown>).id ?? "") || null;
  }
  return null;
}

function normalizeCliIssue(raw: LinearCliIssue): Issue {
  const labels: string[] = [];
  if (Array.isArray(raw.labels)) {
    for (const label of raw.labels) {
      if (typeof label === "string") {
        labels.push(label);
      } else if (label && typeof label === "object" && "name" in label) {
        const name = String(label.name ?? "").trim();
        if (name) labels.push(name);
      }
    }
  }

  return {
    id: String(raw.id ?? ""),
    identifier: String(raw.identifier ?? ""),
    title: String(raw.title ?? ""),
    description: raw.description ? String(raw.description) : null,
    state: extractStateName(raw.state),
    priority: typeof raw.priority === "number" ? raw.priority : null,
    labels,
    assigneeId: extractId(raw.assignee),
    creatorId: extractId(raw.creator),
    createdAt: raw.createdAt ? String(raw.createdAt) : null,
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
    url: raw.url ? String(raw.url) : null,
    blockedBy: [],
  };
}

export class LinearCliTrackerClient implements TrackerClient {
  private readonly runner: CommandRunner;

  constructor(
    private readonly config: TrackerConfig,
    runner?: CommandRunner,
  ) {
    this.runner = runner ?? new ShellCommandRunner();
  }

  private async runLinear(args: string, timeoutMs = 30_000): Promise<string> {
    const env: Record<string, string> = {};
    if (this.config.apiKey) {
      env.LINEAR_API_KEY = this.config.apiKey;
    }

    const result = await this.runner.run(`linear ${args}`, {
      cwd: process.cwd(),
      timeoutMs,
      env,
    });

    if (result.exitCode !== 0) {
      const error = result.stderr || result.stdout || `linear CLI exited with ${result.exitCode}`;
      throw new Error(`linear CLI error: ${error}`);
    }

    return result.stdout;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    if (!this.config.assigneeId) {
      throw new Error("tracker.assignee_id is required — refusing to poll without an assignee filter");
    }

    const allIssues: Issue[] = [];

    for (const state of this.config.activeStates) {
      const output = await this.runLinear(
        `issue query --assignee ${this.config.assigneeId} --state "${state}" --json --limit 0`,
      );
      const parsed = parseJsonSafely<LinearCliIssue[]>(output);
      if (Array.isArray(parsed)) {
        allIssues.push(...parsed.map(normalizeCliIssue));
      }
    }

    // Deduplicate by issue ID
    const seen = new Set<string>();
    return allIssues.filter((issue) => {
      if (seen.has(issue.id)) return false;
      seen.add(issue.id);
      return true;
    });
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];

    const results: Issue[] = [];
    for (const id of issueIds) {
      try {
        const output = await this.runLinear(`issue view ${id} --json`);
        const parsed = parseJsonSafely<LinearCliIssue>(output);
        if (parsed) {
          results.push(normalizeCliIssue(parsed));
        }
      } catch {
        // Issue may have been deleted or is inaccessible
      }
    }
    return results;
  }

  async fetchTerminalIssues(): Promise<Issue[]> {
    if (!this.config.assigneeId) {
      throw new Error("tracker.assignee_id is required — refusing to clean up without an assignee filter");
    }

    const allIssues: Issue[] = [];

    for (const state of this.config.terminalStates) {
      try {
        const output = await this.runLinear(
          `issue query --assignee ${this.config.assigneeId} --state "${state}" --json --limit 0`,
        );
        const parsed = parseJsonSafely<LinearCliIssue[]>(output);
        if (Array.isArray(parsed)) {
          allIssues.push(...parsed.map(normalizeCliIssue));
        }
      } catch {
        // Some terminal states may have no issues
      }
    }

    const seen = new Set<string>();
    return allIssues.filter((issue) => {
      if (seen.has(issue.id)) return false;
      seen.add(issue.id);
      return true;
    });
  }

  async fetchIssueByIdentifier(identifier: string): Promise<Issue | null> {
    const normalized = String(identifier ?? "").trim();
    if (!normalized) return null;

    try {
      const output = await this.runLinear(`issue view ${normalized} --json`);
      const parsed = parseJsonSafely<LinearCliIssue>(output);
      return parsed ? normalizeCliIssue(parsed) : null;
    } catch {
      return null;
    }
  }

  async transitionIssue(issueId: string, stateName: string): Promise<void> {
    await this.runLinear(`issue update ${issueId} --state "${stateName}"`);
  }

  async commentOnIssue(issueId: string, body: string): Promise<void> {
    const commentBody = String(body ?? "").trim();
    if (!commentBody) return;

    const escaped = commentBody.replace(/'/g, `'\\''`);
    await this.runLinear(`issue comment add ${issueId} --body '${escaped}'`);
  }

  async addIssueLabel(issueId: string, labelName: string): Promise<void> {
    const label = normalizeLowercase(labelName);
    if (!label) return;
    await this.runLinear(`issue update ${issueId} --label "${label}"`);
  }

  async removeIssueLabel(issueId: string, labelName: string): Promise<void> {
    const label = normalizeLowercase(labelName);
    if (!label) return;
    try {
      await this.runLinear(`issue update ${issueId} --remove-label "${label}"`);
    } catch {
      // Silently ignore if remove-label is not supported
    }
  }
}
