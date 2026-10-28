import { WorkflowExecutionError, snapshotJsonValue, type JsonValue } from '../../core/index.js'
import type { WorkflowAgentRequest, WorkflowAgentResult } from '../../core/types.js'
import type {
  DshAgentLike,
  DshSubagentActivationLike,
  DshSubagentActivationRuntimeLike,
  DshSubagentRunLike,
  DshSubagentRuntimeLike,
} from './types.js'

/** `ctx.subagents` of either DSH 0.2 generation. */
export type DshSubagentService = DshSubagentRuntimeLike | DshSubagentActivationRuntimeLike

/** Per-start options this adapter may request; each needs the provider capability of the same name. */
type AgentCapability = 'outputSchema' | 'toolFilter'

/**
 * Runs one agent.run@1 request as a child of `parent`. DSH 0.2.0-rc.2 and
 * 0.2.1-alpha.1 expose `start()`; 0.2.1-alpha.3 and later expose only
 * `startActivation()`, whose requests carry no tool filter, so a node with
 * `tools` fails closed there instead of running with a wider tool scope.
 */
export async function executeDshAgent(
  runtime: DshSubagentService,
  request: WorkflowAgentRequest,
  parent: DshAgentLike,
): Promise<WorkflowAgentResult> {
  const required: AgentCapability[] = [
    ...(request.outputSchema === undefined ? [] : ['outputSchema' as const]),
    ...(request.tools === undefined ? [] : ['toolFilter' as const]),
  ]
  const target = selectAgentTarget(runtime, required, request.nodeId)
  const prompt = [{ type: 'text' as const, text: renderDshAgentPrompt(request.prompt, request.skills) }]
  const run = isStartRuntime(runtime)
    ? await runtime.start(target, {
        label: request.nodeId,
        prompt,
        parent,
        signal: request.signal,
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
        ...(request.tools === undefined ? {} : { toolFilter: { allow: request.tools } }),
      })
    : bindActivation(await runtime.startActivation({
        provider: target,
        label: request.nodeId,
        request: { prompt, parent, ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }) },
        signal: request.signal,
        delivery: 'caller',
      }), request.signal)
  let execution: Awaited<typeof run.result> | undefined
  let executionError: unknown
  try {
    execution = await run.result
  } catch (error: unknown) {
    executionError = error
  }
  let disposalError: unknown
  try {
    await run.dispose()
  } catch (error: unknown) {
    disposalError = error
  }
  if (executionError !== undefined || disposalError !== undefined) {
    const errors = [executionError, disposalError].filter(error => error !== undefined)
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'subagent execution and disposal failed')
  }
  if (execution === undefined) throw new Error('subagent result was not available')
  if (execution.stopReason !== 'completed') {
    const diagnostic = execution.diagnostic === undefined ? '' : `: ${execution.diagnostic}`
    throw new WorkflowExecutionError('DSH_AGENT_FAILED', `subagent stopped with ${execution.stopReason}${diagnostic}`, { nodeId: request.nodeId })
  }
  const contentValue = snapshotJsonValue(execution.output)
  if (!Array.isArray(contentValue)) throw new Error('subagent output was not a JSON array')
  const content = contentValue as readonly JsonValue[]
  const structured = execution.structured === undefined ? undefined : snapshotJsonValue(execution.structured)
  return {
    runId: run.id,
    content,
    ...(structured === undefined ? {} : { structured }),
  }
}

/** Agent capabilities this adapter can honour on the current DSH, for authoring Agents. */
export function dshAgentCapabilities(runtime: DshSubagentService): {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
} {
  const names = runtime.list()
  const some = (capability: string) => names.some(name => supports(runtime, name, capability))
  return {
    outputSchema: some('outputSchema'),
    depthLimit: some('depthLimit'),
    toolFilter: some('toolFilter'),
    persona: some('persona'),
  }
}

function isStartRuntime(runtime: DshSubagentService): runtime is DshSubagentRuntimeLike {
  return typeof (runtime as { readonly start?: unknown }).start === 'function'
}

/** A flag the running DSH does not declare counts as unsupported; startActivation has no toolFilter/persona options. */
function supports(runtime: DshSubagentService, name: string, capability: string): boolean {
  if (!isStartRuntime(runtime) && (capability === 'toolFilter' || capability === 'persona')) return false
  const capabilities = runtime.getProvider(name)?.capabilities as Readonly<Record<string, unknown>> | undefined
  return capabilities?.[capability] === true
}

function selectAgentTarget(runtime: DshSubagentService, required: readonly AgentCapability[], nodeId: string): string {
  if (!isStartRuntime(runtime) && typeof runtime.startActivation !== 'function') {
    throw new WorkflowExecutionError('AGENT_TARGET_UNAVAILABLE', 'DSH subagents exposes neither start() nor startActivation()', { nodeId })
  }
  const compatible = runtime.list().filter(name => required.every(capability => supports(runtime, name, capability)))
  for (const preferred of ['spawn', 'general-purpose']) {
    if (compatible.includes(preferred)) return preferred
  }
  if (compatible[0] !== undefined) return compatible[0]
  const needs = required.length === 0 ? '' : ` (requires ${required.join(', ')})`
  const toolScope = !isStartRuntime(runtime) && required.includes('toolFilter')
    ? '; this DSH starts subagents without a per-start toolFilter, so agent.run `tools` cannot be enforced. Remove `tools` to run the child with the parent Agent tool scope'
    : ''
  throw new WorkflowExecutionError('AGENT_TARGET_UNAVAILABLE', `DSH has no registered subagent target compatible with this workflow node${needs}${toolScope}`, { nodeId })
}

/** startActivation's signal stops startup only; after publication the caller cancels through dispose(). */
function bindActivation(activation: DshSubagentActivationLike, signal: AbortSignal): DshSubagentRunLike {
  let disposal: Promise<void> | undefined
  const dispose = () => disposal ??= activation.dispose()
  const stop = () => { void dispose().catch(() => {}) }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  return {
    id: activation.childId,
    result: activation.result,
    async dispose() {
      signal.removeEventListener('abort', stop)
      await dispose()
    },
  }
}

function renderDshAgentPrompt(prompt: string, skills: readonly string[] | undefined): string {
  if (skills === undefined || skills.length === 0) return prompt
  return [
    `Required workflow skill dependencies: ${skills.map(skill => JSON.stringify(skill)).join(', ')}.`,
    'Load and follow those skills when they are available before completing this task.',
    '',
    prompt,
  ].join('\n')
}
