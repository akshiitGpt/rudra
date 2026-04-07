import { EventEmitter } from "node:events";

export type RudraEventType =
  | "orchestrator:started"
  | "orchestrator:tick"
  | "orchestrator:shutdown"
  | "issue:triaged"
  | "issue:dispatched"
  | "issue:completed"
  | "issue:escalated"
  | "issue:failed"
  | "issue:cancelled"
  | "issue:retry:scheduled"
  | "issue:retry:dispatched"
  | "pipeline:stage:start"
  | "pipeline:stage:complete"
  | "pipeline:edge:evaluated"
  | "pipeline:edge:selected"
  | "pipeline:max_visits"
  | "workspace:created"
  | "workspace:cleaned";

export interface RudraEventBase {
  type: RudraEventType;
  timestamp: string;
  issueId?: string;
  issueIdentifier?: string;
  _sequence?: number;
}

interface IssueEventBase extends RudraEventBase {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  issueCreatorId: string | null;
}

export interface OrchestratorStartedEvent extends RudraEventBase {
  type: "orchestrator:started";
  workflowPath: string;
  logsRoot: string;
  pollingMs: number;
}

export interface OrchestratorTickEvent extends RudraEventBase {
  type: "orchestrator:tick";
  running: number;
  claimed: number;
  retrying: number;
  completed: number;
}

export interface OrchestratorShutdownEvent extends RudraEventBase {
  type: "orchestrator:shutdown";
}

export interface IssueDispatchedEvent extends IssueEventBase {
  type: "issue:dispatched";
  state: string;
  attempt: number;
  workspacePath: string;
  workflowName: string;
  successState: string;
  baseBranch: string;
  targetBranch: string;
  mergeStrategy: "pr-only" | "auto-merge";
  labelsToAdd: string[];
  triaged: boolean;
  triageReasoning: string | null;
  triageFallback: boolean;
}

export interface IssueTriagedEvent extends IssueEventBase {
  type: "issue:triaged";
  action: "dispatch" | "request-clarification";
  workflowName: string | null;
  baseBranch: string | null;
  targetBranch: string | null;
  mergeStrategy: "pr-only" | "auto-merge" | null;
  labels: string[];
  reasoning: string | null;
  wasFallback: boolean;
}

export interface IssueCompletedEvent extends IssueEventBase {
  type: "issue:completed";
  completedNodes: string[];
  prUrl: string | null;
}

export interface IssueEscalatedEvent extends IssueEventBase {
  type: "issue:escalated";
  completedNodes: string[];
  reason: string;
}

export interface IssueFailedEvent extends IssueEventBase {
  // Emitted only when Rudra gives up retrying the issue in its current state.
  type: "issue:failed";
  error: string;
  failedStageId: string | null;
  attempt: number;
  /** Set when the failure was classified as non-transient (auth or rate-limit). */
  failureClass?: "auth" | "rate-limit" | null;
}

export interface IssueCancelledEvent extends IssueEventBase {
  type: "issue:cancelled";
  reason: string;
}

export interface IssueRetryScheduledEvent extends IssueEventBase {
  // Emitted for transient failures that will be retried later.
  type: "issue:retry:scheduled";
  attempt: number;
  dueAtMs: number;
  error: string | null;
}

export interface IssueRetryDispatchedEvent extends IssueEventBase {
  type: "issue:retry:dispatched";
  attempt: number;
}

export interface PipelineStageStartEvent extends RudraEventBase {
  type: "pipeline:stage:start";
  issueId: string;
  issueIdentifier: string;
  stageId: string;
  stageLabel: string;
  stageType: "agent" | "tool" | "fan_out" | "fan_in";
  visit: number;
  backend: string | null;
}

export interface PipelineStageCompleteEvent extends RudraEventBase {
  type: "pipeline:stage:complete";
  issueId: string;
  issueIdentifier: string;
  stageId: string;
  exitCode: number | null;
  durationMs: number | null;
  visit: number;
  status: "success" | "failure" | "cancelled" | "wait_human";
}

export interface PipelineEdgeEvaluatedEvent extends RudraEventBase {
  type: "pipeline:edge:evaluated";
  issueId: string;
  issueIdentifier: string;
  fromNodeId: string;
  toNodeId: string;
  condition: string;
  result: string;
}

export interface PipelineEdgeSelectedEvent extends RudraEventBase {
  type: "pipeline:edge:selected";
  issueId: string;
  issueIdentifier: string;
  fromNodeId: string;
  toNodeId: string;
  isDefault: boolean;
}

export interface PipelineMaxVisitsEvent extends RudraEventBase {
  type: "pipeline:max_visits";
  issueId: string;
  issueIdentifier: string;
  stageId: string;
  maxVisits: number;
  visitCount: number;
}

export interface WorkspaceCreatedEvent extends RudraEventBase {
  type: "workspace:created";
  issueIdentifier: string;
  workspacePath: string;
}

export interface WorkspaceCleanedEvent extends RudraEventBase {
  type: "workspace:cleaned";
  issueIdentifier: string;
  workspacePath: string;
}

export type RudraEvent =
  | OrchestratorStartedEvent
  | OrchestratorTickEvent
  | OrchestratorShutdownEvent
  | IssueTriagedEvent
  | IssueDispatchedEvent
  | IssueCompletedEvent
  | IssueEscalatedEvent
  | IssueFailedEvent
  | IssueCancelledEvent
  | IssueRetryScheduledEvent
  | IssueRetryDispatchedEvent
  | PipelineStageStartEvent
  | PipelineStageCompleteEvent
  | PipelineEdgeEvaluatedEvent
  | PipelineEdgeSelectedEvent
  | PipelineMaxVisitsEvent
  | WorkspaceCreatedEvent
  | WorkspaceCleanedEvent;

export type RudraEventMap = {
  [K in RudraEventType]: Extract<RudraEvent, { type: K }>;
};

type AnyEventListener = (event: RudraEvent) => void;

export class RudraEventBus {
  private readonly emitter = new EventEmitter();
  private nextSequence = 0;

  initializeSequence(lastSequence: number): void {
    if (Number.isFinite(lastSequence) && lastSequence > this.nextSequence) {
      this.nextSequence = lastSequence;
    }
  }

  emit(event: RudraEvent): void {
    const sequencedEvent = {
      ...event,
      _sequence: this.nextSequence + 1,
    } satisfies RudraEvent;
    this.nextSequence += 1;
    this.emitter.emit(sequencedEvent.type, sequencedEvent);
    this.emitter.emit("*", sequencedEvent);
  }

  on<T extends RudraEventType>(type: T, listener: (event: RudraEventMap[T]) => void): void {
    this.emitter.on(type, listener as AnyEventListener);
  }

  off<T extends RudraEventType>(type: T, listener: (event: RudraEventMap[T]) => void): void {
    this.emitter.off(type, listener as AnyEventListener);
  }

  onAny(listener: AnyEventListener): void {
    this.emitter.on("*", listener);
  }

  offAny(listener: AnyEventListener): void {
    this.emitter.off("*", listener);
  }
}
