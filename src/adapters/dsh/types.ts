import type {
  JsonObject,
  JsonValue,
  WorkflowEvent,
  WorkflowRunResult,
  WorkflowTemplate,
} from '../../core/index.js'
import type { WorkflowLaunchTarget } from '../../runtime/index.js'

export interface DshSessionLike {
  readonly id?: string
  append(type: string, data: unknown): unknown
}

export interface DshAgentLike {
  readonly session: DshSessionLike
}

export interface DshSubagentRunLike {
  readonly id: string
  readonly result: Promise<{
    readonly output: readonly JsonValue[]
    readonly structured?: unknown
    readonly diagnostic?: string
    readonly stopReason: string
  }>
  dispose(): Promise<void>
}

/** `ctx.subagents` of DSH 0.2.0-rc.2 and 0.2.1-alpha.1: one-shot `start()` with per-start `toolFilter`. */
export interface DshSubagentRuntimeLike {
  list(): readonly string[]
  getProvider(name: string): {
    readonly capabilities: {
      readonly outputSchema: boolean
      readonly depthLimit: boolean
      readonly toolFilter: boolean
      readonly persona: boolean
    }
  } | undefined
  start(target: string, request: {
    readonly label?: string
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
    readonly parent: DshAgentLike
    readonly signal: AbortSignal
    readonly outputSchema?: Readonly<Record<string, unknown>>
    readonly maxDepth?: number
    readonly toolFilter?: {
      readonly allow?: readonly string[]
      readonly deny?: readonly string[]
    }
  }): Promise<DshSubagentRunLike>
}

/**
 * `ctx.subagents` of DSH 0.2.1-alpha.3 and later: `start()` and the per-start
 * `toolFilter`/`persona` options were replaced by `startActivation()`.
 */
export interface DshSubagentActivationRuntimeLike {
  list(): readonly string[]
  getProvider(name: string): {
    readonly capabilities: {
      readonly agentOptions: boolean
      readonly agentPreset: boolean
      readonly outputSchema: boolean
      readonly depthLimit: boolean
    }
  } | undefined
  startActivation(spec: DshSubagentActivationSpec): Promise<DshSubagentActivationLike>
}

export interface DshSubagentActivationSpec {
  readonly provider: string
  readonly label: string
  readonly request: {
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
    readonly parent: DshAgentLike
    readonly outputSchema?: Readonly<Record<string, unknown>>
  }
  /** Cancels startup only; a published activation is stopped through `dispose()`. */
  readonly signal: AbortSignal
  /** `caller` returns the result to the caller without notifying the parent model. */
  readonly delivery: 'parent' | 'caller'
}

export interface DshSubagentActivationLike {
  readonly childId: string
  readonly result: DshSubagentRunLike['result']
  dispose(): Promise<void>
}

export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface DshApprovalRuntimeLike {
  request(request: {
    readonly agent: DshAgentLike
    readonly toolName: string
    readonly callId: string
    readonly reason: string
    readonly signal: AbortSignal
  }): Promise<DshApprovalOutcome>
}

export interface DshToolRuntimeInput {
  readonly callId: string
  readonly name: string
  readonly arguments: JsonObject
  readonly signal: AbortSignal
  readonly agent: DshAgentLike
}

export type DshToolRuntimeResult =
  | { readonly isError: false; readonly value: JsonValue }
  | { readonly isError: true; readonly error: unknown }

/** `ctx.tools` of DSH 0.2.0-rc.2 to 0.2.1-rc.4: `execute()` runs one parsed call. */
export interface DshToolRuntimeLike {
  execute(input: DshToolRuntimeInput): Promise<DshToolRuntimeResult>
}

/** One raw model-style call; `arguments` is the JSON text the executor parses. */
export interface DshToolCallBlock {
  readonly type: 'tool-call'
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface DshToolBatchInput {
  readonly calls: readonly DshToolCallBlock[]
  readonly signal: AbortSignal
  readonly agent?: DshAgentLike
}

export interface DshToolBatchResult {
  readonly results: readonly { readonly callId: string; readonly result: DshToolRuntimeResult }[]
}

/**
 * `ctx.tools` of DSH 0.2.2 and later: `execute()` takes a call batch and is
 * delegated to a pluggable executor; `setExecutor()` identifies this shape.
 */
export interface DshToolBatchRuntimeLike {
  execute(input: DshToolBatchInput): Promise<DshToolBatchResult>
  setExecutor(executor: unknown): () => void
}

export interface DshToolRunContextLike {
  readonly agent?: DshAgentLike
  readonly signal: AbortSignal
}

export interface DshWorkflowToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>
    render(args: unknown, value: JsonValue): readonly { readonly type: 'text'; readonly text: string }[]
  }
  readonly isConcurrencySafe?: (args: unknown) => boolean
  execute(args: unknown, context: DshToolRunContextLike): Promise<JsonValue>
}

export interface DshToolRegistryLike extends DshToolRuntimeLike {
  register(definition: DshWorkflowToolDefinition): () => void
  schemas(scope?: unknown): readonly {
    readonly name: string
    readonly description: string
    readonly parameters: Readonly<Record<string, unknown>>
  }[]
}

export interface DshSkillRuntimeLike {
  register(skill: {
    readonly name: string
    readonly description: string
    readonly source: string
    readonly content: string
    readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  }): () => void
}

export type DshDagWorkflowStartRequest = {
  readonly inputs: JsonObject
  readonly parent: object
  readonly signal?: AbortSignal
  /** Request/transport lifetime; aborting it detaches without cancelling the durable Run. */
  readonly interruptionSignal?: AbortSignal
  readonly onEvent?: (event: WorkflowEvent) => void
} & (
  | { readonly template: WorkflowTemplate; readonly target?: never }
  | { readonly target: WorkflowLaunchTarget; readonly template?: never }
)

export interface DshDagWorkflowEngine {
  start(request: DshDagWorkflowStartRequest): Promise<DshWorkflowRun>
  resume(request: DshDagWorkflowResumeRequest): Promise<DshWorkflowRun>
  cancel(request: DshDagWorkflowCancelRequest): Promise<WorkflowRunResult>
  owns(runId: string, parent: object): Promise<boolean>
}

export interface DshDagWorkflowCancelRequest {
  readonly runId: string
  readonly parent: object
  readonly reason?: string
  readonly signal?: AbortSignal
  readonly onEvent?: (event: WorkflowEvent) => void
}

export interface DshDagWorkflowResumeRequest {
  readonly runId: string
  readonly parent: object
  readonly signal?: AbortSignal
  /** Host/runner shutdown signal; unlike signal it must not cancel the durable Run. */
  readonly interruptionSignal?: AbortSignal
  readonly onEvent?: (event: WorkflowEvent) => void
  readonly unknownNodeResolutions?: Readonly<Record<string, 'retry' | 'fail'>>
}

export interface DshWorkflowRun {
  readonly id: string
  readonly result: Promise<WorkflowRunResult>
  cancel(reason?: string): Promise<void>
  dispose(): Promise<void>
}

export interface DshWorkflowPluginConfig {
  readonly catalog?: 'memory' | 'external'
  readonly runStore?: 'memory' | 'external'
  /** Optional restart coordinator. Both callbacks must use Host-owned session/Agent state. */
  readonly recovery?: {
    readonly reference: (parent: DshAgentLike) => string
    readonly resolve: (authorityRef: string, context: {
      readonly runId: string
      readonly signal: AbortSignal
    }) => Promise<DshAgentLike | undefined>
  }
}

export type DshDagWorkflowEvent = WorkflowEvent
