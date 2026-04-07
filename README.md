# Rudra

A background coding agent that polls Linear for assigned issues, routes them through configurable workflows, and produces pull requests — without human intervention.

Named after the fierce Vedic storm deity: relentless, precise, and transformative.

**Key difference from similar tools:** Rudra uses **CLI tools** for all external integrations — [`gh`](https://cli.github.com/) for GitHub and [`linear`](https://github.com/schpet/linear-cli) for Linear — instead of direct API calls. This means zero API tokens to manage for GitHub (uses your existing `gh auth`), and a simpler mental model for debugging.

## How It Works

You assign a Linear issue to Rudra. Within 30 seconds, it picks it up and runs a multi-stage pipeline: **plan → review plan → code → review code → prepare PR → publish PR**. Each stage is a separate AI agent (Claude or Codex). Review stages can send work back for revision or escalate to a human. When the pipeline finishes, you get a pull request.

The issue description is the prompt. Write it like you're briefing a developer.

## Prerequisites

- **Node.js 20+**
- **[`gh` CLI](https://cli.github.com/)** — authenticated (`gh auth login`)
- **[`linear` CLI](https://github.com/schpet/linear-cli)** — installed and configured
- **At least one coding agent CLI:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) or [Codex](https://github.com/openai/codex) (`codex`)

## Quickstart

### 1. Clone, install, build

```bash
git clone https://github.com/akshiitGpt/rudra.git
cd rudra
npm install
npm run build:orchestrator
```

### 2. Find your Linear user ID

```bash
linear team members
```

Copy your user ID from the output.

### 3. Configure

```bash
cp WORKFLOW.md.example WORKFLOW.md
```

Open `WORKFLOW.md` and replace the placeholder values:

| Placeholder | Where to find it |
|-------------|-----------------|
| `your-linear-user-id` | Step 2 above |
| `your-org/your-repo` | Your GitHub repository |

### 4. Set environment variables

```bash
export LINEAR_API_KEY="lin_api_..."       # for the linear CLI
export RUDRA_API_KEY="any-secret-string"  # protects the Rudra REST API
```

Note: GitHub authentication comes from `gh auth` — no token needed.

### 5. Start the orchestrator

```bash
node orchestrator/dist/index.js
```

Run from the repo root. The API listens on `http://localhost:3847`.

### 6. Give Rudra its first issue

1. Create a Linear issue with a clear title and description
2. Assign it to the user whose ID you configured
3. Set the state to **Todo**
4. Rudra picks it up within ~30 seconds

Verify:

```bash
curl -s -H "Authorization: Bearer $RUDRA_API_KEY" http://localhost:3847/runs?limit=5
```

## Key Concepts

- **Workflows** — Directed graphs (DOT format) where each node is an agent or tool stage. Edges route based on agent decisions (`lgtm`, `revise`, `escalate`).
- **Agents** — Named configurations combining a backend + model + prompt.
- **Backends** — Command templates for invoking coding agents (e.g., `claude --model {{ model }} -p {{ prompt }}`).
- **Hooks** — Shell scripts for workspace setup (`after_create` clones the repo, `before_run` resets to latest).

## CLI-First Architecture

Unlike tools that embed HTTP clients, Rudra delegates to CLIs:

| Integration | Tool | Why |
|------------|------|-----|
| GitHub | `gh` CLI | Uses existing auth, rich JSON output, no token management |
| Linear | `linear` CLI | Same benefits — query, update, comment via shell |
| Coding | `claude` / `codex` | Native CLI invocation with session support |

This makes Rudra easier to debug (just run the same commands manually) and lighter to configure.

## Project Structure

```
rudra/
├── orchestrator/           # The engine — polls Linear, runs workflows
│   └── src/                # TypeScript source
├── pipelines/              # DOT workflow definitions
│   ├── default.dot         # Plan → review → code → review → PR
│   ├── revision.dot        # Handle PR review feedback
│   ├── document.dot        # Documentation workflow
│   └── knowledge.dot       # Knowledge article drafting
├── WORKFLOW.md.example     # Ready-to-use configuration template
└── README.md
```

## Development

```bash
npm install
npm run build:orchestrator
```

## License

MIT
