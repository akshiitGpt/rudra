import { createHmac, timingSafeEqual } from "node:crypto";

import { GitHubConfig, PullRequestMetadata } from "./types";
import { CommandRunner, ShellCommandRunner } from "./process";

/**
 * GitHub integration using the `gh` CLI instead of the REST/GraphQL API.
 *
 * Every GitHub interaction is routed through `gh` — no direct HTTP calls.
 */

export interface GitHubWebhookEnvelope {
  deliveryId: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface GitHubPullRequestDetails extends PullRequestMetadata {
  repository: string;
  number: number;
  merged: boolean;
}

export interface GitHubReview {
  id: number;
  state: string;
  body: string | null;
  submittedAt: string | null;
  userLogin: string | null;
  htmlUrl: string | null;
}

export interface GitHubIssueComment {
  id: number;
  body: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  userLogin: string | null;
  htmlUrl: string | null;
  isBot: boolean;
}

export interface GitHubOpenPullRequest {
  number: number;
  headRefName: string | null;
  baseRefName: string | null;
  url: string | null;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface UpdatePullRequestInput {
  title?: string;
  body?: string;
}

export interface GitHubReviewComment {
  id: number;
  body: string | null;
  path: string | null;
  line: number | null;
  reviewId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  userLogin: string | null;
  htmlUrl: string | null;
  isBot: boolean;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === "string" ? raw : null;
}

export function verifyGitHubWebhookSignature(opts: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
}): boolean {
  const signatureHeader = String(opts.signatureHeader ?? "").trim();
  if (!signatureHeader.startsWith("sha256=") || !opts.secret) return false;

  const received = Buffer.from(signatureHeader, "utf8");
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", opts.secret).update(opts.rawBody).digest("hex")}`,
    "utf8",
  );
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}

function parseGitHubWebhookPayload(rawBody: string): Record<string, unknown> {
  const trimmed = rawBody.trim();
  if (!trimmed) throw new Error("missing GitHub webhook payload");

  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Record<string, unknown>;

  const formBody = new URLSearchParams(trimmed);
  const payload = formBody.get("payload");
  if (!payload) throw new Error("unsupported GitHub webhook payload encoding");

  return JSON.parse(payload) as Record<string, unknown>;
}

export function parseGitHubWebhookRequest(opts: {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
}): GitHubWebhookEnvelope {
  if (!verifyGitHubWebhookSignature({
    rawBody: opts.rawBody,
    signatureHeader: headerValue(opts.headers, "x-hub-signature-256"),
    secret: opts.secret,
  })) {
    throw new Error("invalid GitHub webhook signature");
  }

  const deliveryId = headerValue(opts.headers, "x-github-delivery");
  if (!deliveryId) throw new Error("missing GitHub delivery id");

  const event = headerValue(opts.headers, "x-github-event");
  if (!event) throw new Error("missing GitHub event name");

  return { deliveryId, event, payload: parseGitHubWebhookPayload(opts.rawBody) };
}

export function extractIssueIdentifierFromBranch(headRefName: string | null | undefined): string | null {
  const ref = String(headRefName ?? "").trim().toLowerCase();
  if (!ref) return null;

  const match = ref.match(/(?:^|\/)([a-z]+-\d+)(?:$|[/-])/i);
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function isPullRequestIssueComment(payload: Record<string, unknown>): boolean {
  const issue = payload.issue;
  if (!issue || typeof issue !== "object") return false;
  const pullRequest = (issue as Record<string, unknown>).pull_request;
  return !!pullRequest && typeof pullRequest === "object";
}

export function extractRevisionCommand(body: string | null | undefined, command: string): string | null {
  const content = String(body ?? "").trim();
  const normalizedCommand = String(command ?? "").trim();
  if (!content || !normalizedCommand) return null;

  return content.toLowerCase().startsWith(normalizedCommand.toLowerCase()) ? content : null;
}

function parseJsonSafely<T>(raw: string): T | null {
  try {
    return JSON.parse(raw.trim()) as T;
  } catch {
    return null;
  }
}

function normalizePrFromGh(value: Record<string, unknown>): PullRequestMetadata {
  return {
    url: String(value.url ?? value.html_url ?? "").trim(),
    title: typeof value.title === "string" ? value.title : null,
    number: typeof value.number === "number" ? value.number : Number.isFinite(Number(value.number)) ? Number(value.number) : null,
    headRefName: typeof value.headRefName === "string" ? value.headRefName : null,
    headSha: typeof value.headRefOid === "string" ? value.headRefOid : null,
    state: typeof value.state === "string" ? value.state : null,
  };
}

export class GhCliClient {
  private readonly runner: CommandRunner;

  constructor(
    private readonly config: GitHubConfig,
    runner?: CommandRunner,
  ) {
    this.runner = runner ?? new ShellCommandRunner();
  }

  private async runGh(args: string, cwd?: string, timeoutMs = 30_000): Promise<string> {
    const env: Record<string, string> = {};
    if (this.config.apiKey) {
      env.GH_TOKEN = this.config.apiKey;
    }

    const result = await this.runner.run(`gh ${args}`, {
      cwd: cwd ?? process.cwd(),
      timeoutMs,
      env,
    });

    if (result.exitCode !== 0) {
      const error = result.stderr || result.stdout || `gh exited with ${result.exitCode}`;
      throw new Error(`gh CLI error: ${error}`);
    }

    return result.stdout;
  }

  async fetchPullRequest(repository: string, number: number): Promise<GitHubPullRequestDetails> {
    const output = await this.runGh(
      `pr view ${number} --repo ${repository} --json url,title,number,headRefName,headRefOid,state,isDraft,mergedAt`,
    );
    const data = parseJsonSafely<Record<string, unknown>>(output) ?? {};
    return {
      repository,
      url: String(data.url ?? ""),
      title: typeof data.title === "string" ? data.title : null,
      number: typeof data.number === "number" ? data.number : number,
      headRefName: typeof data.headRefName === "string" ? data.headRefName : null,
      headSha: typeof data.headRefOid === "string" ? data.headRefOid : null,
      state: typeof data.state === "string" ? data.state : null,
      merged: !!data.mergedAt,
    };
  }

  async listBranches(repository: string): Promise<string[]> {
    const output = await this.runGh(
      `api repos/${repository}/branches --paginate --jq '.[].name'`,
    );
    return output.trim().split("\n").filter(Boolean);
  }

  async listOpenPullRequests(repository: string): Promise<GitHubOpenPullRequest[]> {
    const output = await this.runGh(
      `pr list --repo ${repository} --state open --json number,headRefName,baseRefName,url --limit 100`,
    );
    const data = parseJsonSafely<Array<Record<string, unknown>>>(output) ?? [];
    return data.map((entry) => ({
      number: typeof entry.number === "number" ? entry.number : 0,
      headRefName: typeof entry.headRefName === "string" ? entry.headRefName : null,
      baseRefName: typeof entry.baseRefName === "string" ? entry.baseRefName : null,
      url: typeof entry.url === "string" ? entry.url : null,
    })).filter((pr) => pr.number > 0);
  }

  async createPullRequest(repository: string, input: CreatePullRequestInput): Promise<PullRequestMetadata> {
    const draftFlag = input.draft ? "--draft" : "";
    const bodyEscaped = input.body.replace(/'/g, `'\\''`);
    const titleEscaped = input.title.replace(/'/g, `'\\''`);
    const output = await this.runGh(
      `pr create --repo ${repository} --title '${titleEscaped}' --body '${bodyEscaped}' --head ${input.head} --base ${input.base} ${draftFlag} --json url,title,number,headRefName,state`,
    );
    const data = parseJsonSafely<Record<string, unknown>>(output) ?? {};
    return normalizePrFromGh(data);
  }

  async updatePullRequest(repository: string, number: number, input: UpdatePullRequestInput): Promise<PullRequestMetadata> {
    const parts = [`pr edit ${number} --repo ${repository}`];
    if (input.title !== undefined) {
      const titleEscaped = input.title.replace(/'/g, `'\\''`);
      parts.push(`--title '${titleEscaped}'`);
    }
    if (input.body !== undefined) {
      const bodyEscaped = input.body.replace(/'/g, `'\\''`);
      parts.push(`--body '${bodyEscaped}'`);
    }
    await this.runGh(parts.join(" "));

    return this.fetchPullRequestMetadata(repository, number);
  }

  async enablePullRequestAutoMerge(
    repository: string,
    number: number,
    mergeMethod: "squash" | "merge" | "rebase" = "squash",
  ): Promise<void> {
    await this.runGh(
      `pr merge ${number} --repo ${repository} --auto --${mergeMethod}`,
    );
  }

  async listPullRequestReviews(repository: string, number: number): Promise<GitHubReview[]> {
    const output = await this.runGh(
      `api repos/${repository}/pulls/${number}/reviews --paginate`,
    );
    const data = parseJsonSafely<Array<Record<string, unknown>>>(output) ?? [];
    return data.map((entry) => {
      const user = entry.user && typeof entry.user === "object" ? entry.user as Record<string, unknown> : null;
      return {
        id: Number(entry.id ?? 0),
        state: String(entry.state ?? "").trim().toLowerCase(),
        body: typeof entry.body === "string" ? entry.body : null,
        submittedAt: typeof entry.submitted_at === "string" ? entry.submitted_at : null,
        userLogin: user ? String(user.login ?? "") || null : null,
        htmlUrl: typeof entry.html_url === "string" ? entry.html_url : null,
      };
    });
  }

  async listIssueComments(repository: string, number: number): Promise<GitHubIssueComment[]> {
    const output = await this.runGh(
      `api repos/${repository}/issues/${number}/comments --paginate`,
    );
    const data = parseJsonSafely<Array<Record<string, unknown>>>(output) ?? [];
    return data.map((entry) => {
      const user = entry.user && typeof entry.user === "object" ? entry.user as Record<string, unknown> : null;
      return {
        id: Number(entry.id ?? 0),
        body: typeof entry.body === "string" ? entry.body : null,
        createdAt: typeof entry.created_at === "string" ? entry.created_at : null,
        updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : null,
        userLogin: user ? String(user.login ?? "") || null : null,
        htmlUrl: typeof entry.html_url === "string" ? entry.html_url : null,
        isBot: user ? String(user.type ?? "").trim().toLowerCase() === "bot" : false,
      };
    });
  }

  async listReviewComments(repository: string, number: number): Promise<GitHubReviewComment[]> {
    const output = await this.runGh(
      `api repos/${repository}/pulls/${number}/comments --paginate`,
    );
    const data = parseJsonSafely<Array<Record<string, unknown>>>(output) ?? [];
    return data.map((entry) => {
      const user = entry.user && typeof entry.user === "object" ? entry.user as Record<string, unknown> : null;
      return {
        id: Number(entry.id ?? 0),
        body: typeof entry.body === "string" ? entry.body : null,
        path: typeof entry.path === "string" ? entry.path : null,
        line: typeof entry.line === "number" ? entry.line : null,
        reviewId: typeof entry.pull_request_review_id === "number" ? entry.pull_request_review_id : null,
        createdAt: typeof entry.created_at === "string" ? entry.created_at : null,
        updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : null,
        userLogin: user ? String(user.login ?? "") || null : null,
        htmlUrl: typeof entry.html_url === "string" ? entry.html_url : null,
        isBot: user ? String(user.type ?? "").trim().toLowerCase() === "bot" : false,
      };
    });
  }

  private async fetchPullRequestMetadata(repository: string, number: number): Promise<PullRequestMetadata> {
    const output = await this.runGh(
      `pr view ${number} --repo ${repository} --json url,title,number,headRefName,headRefOid,state`,
    );
    const data = parseJsonSafely<Record<string, unknown>>(output) ?? {};
    return normalizePrFromGh(data);
  }
}
