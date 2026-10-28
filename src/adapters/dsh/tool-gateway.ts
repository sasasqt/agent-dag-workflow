import { WorkflowExecutionError } from '../../core/errors.js'
import type { JsonObject, JsonValue, WorkflowToolGateway, WorkflowToolRequest } from '../../core/types.js'
import type { DshAgentLike, DshToolBatchRuntimeLike, DshToolRuntimeLike } from './types.js'

export interface DshToolExecutionInput {
  readonly callId: string
  readonly name: string
  readonly arguments: JsonObject
  readonly signal: AbortSignal
  readonly agent: unknown
}

export type DshToolExecutionResult =
  | { readonly isError: false; readonly value: JsonValue }
  | { readonly isError: true; readonly error: unknown }

export type DshToolExecute = (input: DshToolExecutionInput) => Promise<DshToolExecutionResult>

/** `ctx.tools` of either DSH 0.2 generation. */
export type DshToolService = DshToolRuntimeLike | DshToolBatchRuntimeLike

/**
 * Adapts the public result shape of `ctx.tools.execute()` without importing
 * Harness packages into the workflow kernel. A Host plugin captures the
 * owning Agent and branded CallId when it supplies `execute`; given the
 * `ctx.tools` service itself, the gateway uses the call shape that service
 * declares (one call before DSH 0.2.2, one-call batches from 0.2.2).
 */
export function createDshToolGateway(execute: DshToolExecute | DshToolService): WorkflowToolGateway {
  return {
    async execute(request: WorkflowToolRequest): Promise<JsonValue> {
      const result = isToolService(execute)
        ? await executeOnService(execute, request)
        : await execute(singleCall(request))
      if (result.isError) {
        throw new WorkflowExecutionError('DSH_TOOL_FAILED', renderToolError(result.error), { nodeId: request.nodeId })
      }
      return result.value
    },
  }
}

function singleCall(request: WorkflowToolRequest): DshToolExecutionInput {
  return {
    callId: request.invocationId,
    name: request.uses,
    arguments: request.inputs,
    signal: request.signal,
    agent: request.authority,
  }
}

async function executeOnService(tools: DshToolService, request: WorkflowToolRequest): Promise<DshToolExecutionResult> {
  const agent = request.authority
  if (!isDshAgentLike(agent)) {
    throw new WorkflowExecutionError('DSH_AGENT_MISSING', 'tool.call requires the owning DSH Agent', { nodeId: request.nodeId })
  }
  if (!isBatchToolService(tools)) return (tools as DshToolRuntimeLike).execute({ ...singleCall(request), agent })
  let batch: Awaited<ReturnType<DshToolBatchRuntimeLike['execute']>>
  try {
    // No toolSet: the batch admits unconditional registrations, as the single-call API did.
    batch = await tools.execute({
      calls: [{ type: 'tool-call', id: request.invocationId, name: request.uses, arguments: JSON.stringify(request.inputs) }],
      signal: request.signal,
      agent,
    })
  } catch (error: unknown) {
    // ToolBatchExecutionError: the executor failed internally after draining the batch.
    const cause = error instanceof Error && error.cause !== undefined ? `: ${renderToolError(error.cause)}` : ''
    throw new WorkflowExecutionError('DSH_TOOL_FAILED', `${renderToolError(error)}${cause}`, { nodeId: request.nodeId, cause: error })
  }
  const settled = Array.isArray(batch?.results) ? batch.results : []
  const [entry] = settled
  if (settled.length !== 1 || entry?.callId !== request.invocationId) {
    throw new WorkflowExecutionError('DSH_TOOL_FAILED', `DSH tool batch returned ${settled.length} result(s) without one for call ${request.invocationId}`, { nodeId: request.nodeId })
  }
  return entry.result
}

/** A DSH Agent exposes the Session its tool and subagent calls append to. */
export function isDshAgentLike(value: unknown): value is DshAgentLike {
  if (value === null || typeof value !== 'object' || !('session' in value)) return false
  const session = value.session
  return session !== null && typeof session === 'object' && 'append' in session && typeof session.append === 'function'
}

function isToolService(value: DshToolExecute | DshToolService): value is DshToolService {
  return typeof (value as { readonly execute?: unknown }).execute === 'function'
}

/** `setExecutor()` ships with the batch `execute()` (DSH 0.2.2); the single-call ToolRuntime lacks it. */
function isBatchToolService(tools: DshToolService): tools is DshToolBatchRuntimeLike {
  return typeof (tools as { readonly setExecutor?: unknown }).setExecutor === 'function'
}

function renderToolError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
  return String(error)
}
