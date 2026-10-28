// The DSH 0.2 line ships two generations of the subagent and tool host APIs. The fakes
// below mirror the published declarations:
//  - @deepseek-ai/dsh-subagent 0.2.0-rc.2 / 0.2.1-alpha.1: SubagentRuntime.start(name, SubagentStartRequest)
//    → SubagentRun { id, result, dispose }; toolFilter "requires SubagentCapabilities.toolFilter; rejected at
//    start otherwise".
//  - @deepseek-ai/dsh-subagent 0.2.1-alpha.3 … 0.2.2-alpha.2: no start; startActivation(SubagentActivationSpec
//    { provider, label, request, signal, delivery }) → SubagentActivation { childId, result, dispose }, where
//    signal only cancels startup; capabilities are { agentOptions, agentPreset, outputSchema, depthLimit }.
//  - @deepseek-ai/dsh-tools 0.2.0-rc.2 … 0.2.1-rc.4: ToolRuntime.execute(ToolExecutionInput) → ToolExecutionResult
//    (with executionMode, without setExecutor).
//  - @deepseek-ai/dsh-tools 0.2.2-alpha.2: ToolsService.execute(ToolBatchInput { calls: ToolCallBlock[], signal,
//    agent? }) → ToolBatchResult { results: { callId, result }[], additionalContexts, concluded }, with setExecutor.
//    ToolCallBlock is { type: 'tool-call', id, name, arguments: <raw JSON string> }.
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as DshWorkflowPlugin from '../../src/adapters/dsh/index.js'
import type { DshAgentLike, DshWorkflowToolDefinition } from '../../src/adapters/dsh/index.js'
import type { JsonObject, JsonValue, WorkflowTemplate } from '../../src/core/index.js'

type ToolExecutionResult =
  | { readonly isError: false; readonly value: JsonValue; readonly content: readonly unknown[] }
  | { readonly isError: true; readonly error: { readonly message: string; readonly info?: { readonly name: string; readonly code: string } }; readonly content: readonly unknown[] }
interface ToolCallBlock { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }
interface ToolBatchInput { readonly calls: readonly ToolCallBlock[]; readonly signal: AbortSignal; readonly agent?: unknown }
interface ToolBatchResult {
  readonly results: readonly { readonly callId: string; readonly result: ToolExecutionResult }[]
  readonly additionalContexts: readonly unknown[]
  readonly concluded: boolean
}
interface SubagentResult { readonly output: readonly JsonValue[]; readonly structured?: unknown; readonly diagnostic?: string; readonly stopReason: string }
interface SubagentActivationSpec {
  readonly provider: string
  readonly label: string
  readonly request: { readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]; readonly parent: unknown; readonly outputSchema?: unknown }
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}

/** Mirrors dsh-tools 0.2.2 executor ToolBatchExecutionError(cause, partial). */
class ToolBatchExecutionError extends Error {
  constructor(cause: unknown, readonly partial: ToolBatchResult) {
    super('Tool batch execution failed', { cause })
    this.name = 'ToolBatchExecutionError'
  }
}

class Registry extends Service {
  readonly definitions = new Map<string, DshWorkflowToolDefinition>()
  register(definition: DshWorkflowToolDefinition): () => void {
    this.definitions.set(definition.name, definition)
    return () => { this.definitions.delete(definition.name) }
  }
  schemas() { return [...this.definitions.values()].map(({ name, description, parameters }) => ({ name, description, parameters })) }
}

/** dsh-tools 0.2.2 ToolsService: batch execute plus setExecutor. */
class BatchTools extends Registry {
  readonly batches: ToolBatchInput[] = []
  respond: (input: ToolBatchInput) => Promise<ToolBatchResult> = async input => ({
    results: input.calls.map(call => ({
      callId: call.id,
      result: { isError: false as const, value: { echo: (JSON.parse(call.arguments) as JsonObject).message ?? null }, content: [] },
    })),
    additionalContexts: [],
    concluded: false,
  })
  constructor(ctx: Context) { super(ctx, 'tools') }
  async execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    this.batches.push(input)
    return this.respond(input)
  }
  setExecutor(_executor: unknown): () => void { return () => {} }
}

/** dsh-tools 0.2.0-rc.2 … 0.2.1-rc.4 ToolRuntime: one parsed call per execute. */
class SingleCallTools extends Registry {
  constructor(ctx: Context) { super(ctx, 'tools') }
  async execute(input: { readonly arguments: JsonObject }): Promise<ToolExecutionResult> {
    return { isError: false, value: { echo: input.arguments.message ?? null }, content: [] }
  }
  executionMode() { return { kind: 'parallel' as const } }
}

/** dsh-subagent 0.2.1-alpha.3 … 0.2.2-alpha.2 SubagentRuntime. */
class ActivationSubagents extends Service {
  readonly activations: SubagentActivationSpec[] = []
  readonly dispose = vi.fn(async () => {})
  result: (spec: SubagentActivationSpec) => Promise<SubagentResult> = async () => ({
    output: [{ type: 'text', text: 'child answer' }], structured: { answer: 'child answer' }, stopReason: 'completed',
  })
  constructor(ctx: Context) { super(ctx, 'subagents') }
  list(): readonly string[] { return ['fork', 'spawn'] }
  getProvider(name: string) {
    return name === 'spawn' || name === 'fork'
      ? { capabilities: { agentOptions: true, agentPreset: name === 'spawn', outputSchema: true, depthLimit: true } }
      : undefined
  }
  async startActivation(spec: SubagentActivationSpec) {
    this.activations.push(spec)
    return { childId: `child-${this.activations.length}`, result: this.result(spec), dispose: this.dispose }
  }
}

/** dsh-subagent 0.2.0-rc.2 SubagentRuntime; start enforces capabilities like the service does. */
class Rc2Subagents extends Service {
  readonly starts: [string, { readonly toolFilter?: unknown; readonly outputSchema?: unknown }][] = []
  providers: Readonly<Record<string, { readonly outputSchema: boolean; readonly depthLimit: boolean; readonly toolFilter: boolean; readonly persona: boolean }>> = {
    acp: { outputSchema: true, depthLimit: false, toolFilter: false, persona: false },
    local: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
  }
  constructor(ctx: Context) { super(ctx, 'subagents') }
  list(): readonly string[] { return Object.keys(this.providers) }
  getProvider(name: string) {
    const capabilities = this.providers[name]
    return capabilities === undefined ? undefined : { capabilities: { agentOptions: false, ...capabilities } }
  }
  async start(name: string, request: { readonly toolFilter?: unknown; readonly outputSchema?: unknown }) {
    this.starts.push([name, request])
    const capabilities = this.providers[name]
    if (request.toolFilter !== undefined && capabilities?.toolFilter !== true) throw new Error(`UNSUPPORTED_CAPABILITY: ${name} toolFilter`)
    if (request.outputSchema !== undefined && capabilities?.outputSchema !== true) throw new Error(`UNSUPPORTED_CAPABILITY: ${name} outputSchema`)
    return { id: `rc2-${name}`, result: Promise.resolve({ output: [], structured: { answer: `from ${name}` }, stopReason: 'completed' }), async dispose() {} }
  }
}

class Approval extends Service {
  constructor(ctx: Context) { super(ctx, 'approval') }
  async request() { return 'allowed-once' as const }
}
class Skills extends Service {
  constructor(ctx: Context) { super(ctx, 'skills') }
  register(): () => void { return () => {} }
}
class Session { readonly id = 'session-1'; append(): void {} }

const childSchema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }

function toolTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'compat-tool', name: 'Compat tool' },
    spec: {
      requires: [{ kind: 'capability', uses: 'gateway.tool.execute' }, { kind: 'tool', uses: 'echo' }],
      inputSchema: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } },
      outputSchema: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'echo', uses: 'tool.call@1', with: { uses: 'echo' }, inputs: { message: { input: { path: ['message'] } } } },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { answer: { output: { nodeId: 'echo', path: ['result', 'echo'] } } } },
      ],
      edges: [{ id: 'a', source: 'start', target: 'echo' }, { id: 'b', source: 'echo', target: 'end' }],
      outputs: { answer: { output: { nodeId: 'end', path: ['answer'] } } },
    },
  }
}

function agentTemplate(options: { readonly tools?: readonly string[]; readonly hold?: boolean } = {}): WorkflowTemplate {
  const before = options.hold === true ? 'hold' : 'start'
  return {
    apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'compat-agent', name: 'Compat agent' },
    spec: {
      requires: [
        { kind: 'capability', uses: 'gateway.agent.execute' },
        ...(options.tools ?? []).map(uses => ({ kind: 'tool' as const, uses })),
      ],
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['answer', 'child'],
        properties: { answer: { type: 'string' }, child: { type: 'string' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        ...(options.hold === true ? [{ id: 'hold', uses: 'test.hold@1', with: {}, inputs: {} }] : []),
        {
          id: 'delegate', uses: 'agent.run@1',
          with: { prompt: 'Produce the answer.', outputSchema: childSchema, ...(options.tools === undefined ? {} : { tools: [...options.tools] }) },
          inputs: { topic: { literal: 'DSH' } },
        },
        {
          id: 'end', uses: 'core.end@1', with: {},
          inputs: {
            answer: { output: { nodeId: 'delegate', path: ['structured', 'answer'] } },
            child: { output: { nodeId: 'delegate', path: ['runId'] } },
          },
        },
      ],
      edges: [
        ...(options.hold === true ? [{ id: 'h', source: 'start', target: 'hold' }] : []),
        { id: 'a', source: before, target: 'delegate' },
        { id: 'b', source: 'delegate', target: 'end' },
      ],
      outputs: { answer: { output: { nodeId: 'end', path: ['answer'] } }, child: { output: { nodeId: 'end', path: ['child'] } } },
    },
  }
}

async function mount(tools: typeof BatchTools | typeof SingleCallTools, subagents: typeof ActivationSubagents | typeof Rc2Subagents) {
  const ctx = new Context()
  await ctx.plugin(tools)
  await ctx.plugin(subagents)
  await ctx.plugin(Approval)
  await ctx.plugin(Skills)
  await ctx.plugin(DshWorkflowPlugin)
  const parent: DshAgentLike = { session: new Session() }
  return { ctx, parent }
}

/** The suite shares a typed Context augmentation with plugin.spec.ts; these fakes are looked up untyped. */
function service<T>(ctx: Context, name: 'tools' | 'subagents'): T {
  return ctx.get(name) as unknown as T
}

async function eventsOf(ctx: Context, runId: string) {
  return (await ctx.get('workflowRuns')!.readEvents(runId)) as readonly { readonly type: string; readonly nodeId?: string; readonly invocationId?: string; readonly error?: string }[]
}

describe('W1-24 agent.run@1 on DSH with startActivation only (>= 0.2.1-alpha.3)', () => {
  it('starts the child through startActivation with caller delivery and disposes it', async () => {
    const { ctx, parent } = await mount(BatchTools, ActivationSubagents)
    const subagents = service<ActivationSubagents>(ctx, 'subagents')

    const result = await (await ctx.dagWorkflowEngine.start({ template: agentTemplate(), inputs: {}, parent })).result

    expect(result).toMatchObject({ status: 'completed', outputs: { answer: 'child answer', child: 'child-1' } })
    expect(subagents.activations).toEqual([{
      provider: 'spawn',
      label: 'delegate',
      delivery: 'caller',
      signal: expect.any(AbortSignal),
      request: {
        prompt: [{ type: 'text', text: expect.stringContaining('Produce the answer.') }],
        parent,
        outputSchema: childSchema,
      },
    }])
    expect(subagents.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes a published activation when the run is cancelled', async () => {
    const { ctx, parent } = await mount(BatchTools, ActivationSubagents)
    const subagents = service<ActivationSubagents>(ctx, 'subagents')
    let settle!: (value: SubagentResult) => void
    subagents.result = () => new Promise(resolve => { settle = resolve })
    subagents.dispose.mockImplementation(async () => { settle({ output: [], stopReason: 'aborted' }) })

    const run = await ctx.dagWorkflowEngine.start({ template: agentTemplate(), inputs: {}, parent })
    await vi.waitFor(() => { expect(subagents.activations).toHaveLength(1) })
    await run.cancel('stop')
    const result = await run.result

    expect(result).toMatchObject({ status: 'cancelled', nodeStates: { delegate: 'cancelled' } })
    // The activation signal only cancels startup; cancellation after publication goes through dispose().
    await vi.waitFor(() => { expect(subagents.dispose).toHaveBeenCalled() })
  })

  it('reports a rejected activation result after disposing the child', async () => {
    const { ctx, parent } = await mount(BatchTools, ActivationSubagents)
    const subagents = service<ActivationSubagents>(ctx, 'subagents')
    subagents.result = async () => { throw new Error('structured capture failed') }

    const result = await (await ctx.dagWorkflowEngine.start({ template: agentTemplate(), inputs: {}, parent })).result

    expect(result).toMatchObject({ status: 'failed', error: 'structured capture failed' })
    expect(subagents.dispose).toHaveBeenCalledTimes(1)
  })

  it('fails the node when activation teardown fails', async () => {
    const { ctx, parent } = await mount(BatchTools, ActivationSubagents)
    const subagents = service<ActivationSubagents>(ctx, 'subagents')
    subagents.dispose.mockRejectedValue(new Error('teardown failed'))

    const teardown = await (await ctx.dagWorkflowEngine.start({ template: agentTemplate(), inputs: {}, parent })).result
    subagents.result = async () => { throw new Error('structured capture failed') }
    const both = await (await ctx.dagWorkflowEngine.start({ template: agentTemplate(), inputs: {}, parent })).result

    expect(teardown).toMatchObject({ status: 'failed', error: 'teardown failed' })
    expect(both).toMatchObject({ status: 'failed', error: 'subagent execution and disposal failed' })
  })
})

describe('W1-36 agent.run@1 `tools` where DSH has no per-start toolFilter', () => {
  it('fails closed before starting any child', async () => {
    const { ctx, parent } = await mount(BatchTools, ActivationSubagents)
    const subagents = service<ActivationSubagents>(ctx, 'subagents')

    const result = await (await ctx.dagWorkflowEngine.start({ template: agentTemplate({ tools: ['web_search'] }), inputs: {}, parent })).result

    expect(result).toMatchObject({ status: 'failed', nodeStates: { delegate: 'failed' } })
    if (result.status !== 'failed') throw new Error('expected failure')
    expect(result.error).toMatch(/toolFilter/)
    expect(subagents.activations).toEqual([])
  })

  it('reports no tool filter capability to authoring Agents', async () => {
    const { ctx, parent } = await mount(BatchTools, ActivationSubagents)
    const definition = service<BatchTools>(ctx, 'tools').definitions.get('workflow_nodes_list')!

    const listed = await definition.execute({}, { agent: parent, signal: new AbortController().signal }) as { readonly agent: { readonly capabilities: JsonObject } }

    expect(listed.agent.capabilities).toMatchObject({ outputSchema: true, toolFilter: false })
  })

  it('fails closed when a run started on rc.2 with `tools` is recovered on a startActivation DSH', async () => {
    const ctx = new Context()
    await ctx.plugin(SingleCallTools)
    const rc2 = await ctx.plugin(Rc2Subagents)
    await ctx.plugin(Approval)
    await ctx.plugin(Skills)
    await ctx.plugin(DshWorkflowPlugin.WorkflowScriptRuntimeRegistryService)
    await ctx.plugin(DshWorkflowPlugin.WorkflowNodeRegistryService)
    await ctx.plugin(DshWorkflowPlugin.InMemoryWorkflowRunsService)
    let hold = true
    let held = 0
    ctx.workflowNodes.register({
      type: 'test.hold', version: 1, title: 'Hold', description: 'Blocks until the run is detached.',
      configSchema: { type: 'object', additionalProperties: false },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', additionalProperties: false },
      outputPorts: ['success'], capabilities: [], effects: 'deterministic', retry: 'safe',
      async execute(execution) {
        held += 1
        if (hold) await new Promise((_resolve, reject) => { execution.signal.addEventListener('abort', () => { reject(new Error('detached')) }, { once: true }) })
        return { outputs: {} }
      },
    })
    const parent: DshAgentLike = { session: new Session() }
    const config = { runStore: 'external' as const, recovery: { reference: () => 'session:owner', async resolve() { return parent } } }
    const first = await ctx.plugin(DshWorkflowPlugin, config)
    const run = await ctx.dagWorkflowEngine.start({ template: agentTemplate({ tools: ['web_search'], hold: true }), inputs: {}, parent })
    await vi.waitFor(() => { expect(held).toBe(1) })
    await first.dispose()
    await run.result
    expect((await ctx.workflowRuns.loadRun(run.id))?.checkpoint.status).toBe('running')

    hold = false
    await rc2.dispose()
    await ctx.plugin(ActivationSubagents)
    const second = await ctx.plugin(DshWorkflowPlugin, config)
    await vi.waitFor(async () => { expect((await ctx.workflowRuns.loadRun(run.id))?.checkpoint.status).toBe('failed') })

    const failed = (await eventsOf(ctx, run.id)).find(event => event.type === 'node.failed')
    expect(failed).toMatchObject({ nodeId: 'delegate', error: expect.stringMatching(/toolFilter/) })
    expect(service<ActivationSubagents>(ctx, 'subagents').activations).toEqual([])
    await second.dispose()
  })
})

describe('W1-26 provider selection covers every capability the node requests (0.2.0-rc.2)', () => {
  it('picks the provider that supports toolFilter for a node with tools', async () => {
    const { ctx, parent } = await mount(SingleCallTools, Rc2Subagents)
    const subagents = service<Rc2Subagents>(ctx, 'subagents')

    const result = await (await ctx.dagWorkflowEngine.start({ template: agentTemplate({ tools: ['web_search'] }), inputs: {}, parent })).result

    expect(result).toMatchObject({ status: 'completed', outputs: { answer: 'from local', child: 'rc2-local' } })
    expect(subagents.starts).toEqual([['local', expect.objectContaining({ toolFilter: { allow: ['web_search'] }, outputSchema: childSchema })]])
  })

  it('does not start an incompatible provider when none supports the request', async () => {
    const { ctx, parent } = await mount(SingleCallTools, Rc2Subagents)
    const subagents = service<Rc2Subagents>(ctx, 'subagents')
    subagents.providers = { acp: { outputSchema: false, depthLimit: false, toolFilter: true, persona: false } }

    const result = await (await ctx.dagWorkflowEngine.start({ template: agentTemplate(), inputs: {}, parent })).result

    expect(result).toMatchObject({ status: 'failed' })
    if (result.status !== 'failed') throw new Error('expected failure')
    expect(result.error).toMatch(/outputSchema/)
    expect(subagents.starts).toEqual([])
  })
})

describe('W1-25 tool.call@1 on the batch ToolsService (0.2.2)', () => {
  it('sends one raw tool-call block and returns its value', async () => {
    const { ctx, parent } = await mount(BatchTools, ActivationSubagents)
    const tools = service<BatchTools>(ctx, 'tools')

    const result = await (await ctx.dagWorkflowEngine.start({ template: toolTemplate(), inputs: { message: 'hi' }, parent })).result

    expect(result).toMatchObject({ status: 'completed', outputs: { answer: 'hi' } })
    const requested = (await eventsOf(ctx, result.runId)).find(event => event.type === 'capability.requested')
    expect(tools.batches).toEqual([{
      calls: [{ type: 'tool-call', id: requested?.invocationId, name: 'echo', arguments: '{"message":"hi"}' }],
      signal: expect.any(AbortSignal),
      agent: parent,
    }])
  })

  it('maps an isError result to a failed node with the tool message', async () => {
    const { ctx, parent } = await mount(BatchTools, ActivationSubagents)
    const tools = service<BatchTools>(ctx, 'tools')
    tools.respond = async input => ({
      results: input.calls.map(call => ({ callId: call.id, result: { isError: true as const, error: { message: 'upstream rejected' }, content: [] } })),
      additionalContexts: [], concluded: false,
    })

    const result = await (await ctx.dagWorkflowEngine.start({ template: toolTemplate(), inputs: { message: 'hi' }, parent })).result

    expect(result).toMatchObject({ status: 'failed', error: 'upstream rejected', nodeStates: { echo: 'failed' } })
  })

  it('fails the node when the batch has no result for the call', async () => {
    const { ctx, parent } = await mount(BatchTools, ActivationSubagents)
    const tools = service<BatchTools>(ctx, 'tools')
    const success = { isError: false as const, value: { echo: 'wrong call' }, content: [] }
    const responses: ((input: ToolBatchInput) => ToolBatchResult)[] = [
      () => ({ results: [{ callId: 'another-call', result: success }], additionalContexts: [], concluded: false }),
      () => ({ results: [], additionalContexts: [], concluded: false }),
      input => ({ results: [...input.calls, ...input.calls].map(call => ({ callId: call.id, result: success })), additionalContexts: [], concluded: false }),
    ]
    const results = []
    for (const response of responses) {
      tools.respond = async input => response(input)
      results.push(await (await ctx.dagWorkflowEngine.start({ template: toolTemplate(), inputs: { message: 'hi' }, parent })).result)
    }

    for (const result of results) {
      expect(result).toMatchObject({ status: 'failed', nodeStates: { echo: 'failed' } })
      if (result.status !== 'failed') throw new Error('expected failure')
      expect(result.error).toMatch(/batch/)
    }
  })

  it('maps a rejected batch to a failed node with the executor cause', async () => {
    const { ctx, parent } = await mount(BatchTools, ActivationSubagents)
    const tools = service<BatchTools>(ctx, 'tools')
    tools.respond = async () => {
      throw new ToolBatchExecutionError(new Error('scheduler crashed'), { results: [], additionalContexts: [], concluded: false })
    }

    const result = await (await ctx.dagWorkflowEngine.start({ template: toolTemplate(), inputs: { message: 'hi' }, parent })).result

    expect(result).toMatchObject({ status: 'failed', error: 'Tool batch execution failed: scheduler crashed', nodeStates: { echo: 'failed' } })
  })

  it('ends the node cancelled when the batch reports calls aborted before dispatch', async () => {
    const { ctx, parent } = await mount(BatchTools, ActivationSubagents)
    const tools = service<BatchTools>(ctx, 'tools')
    let answered: Promise<ToolBatchResult> | undefined
    // Like executeToolBatch, answer every input call with the synthetic pre-dispatch abort result.
    tools.respond = input => answered = new Promise((resolve, reject) => {
      input.signal.addEventListener('abort', () => {
        if (!Array.isArray(input.calls)) {
          reject(new TypeError('ToolBatchInput.calls must be an array'))
          return
        }
        resolve({
          results: input.calls.map(call => ({
            callId: call.id,
            result: {
              isError: true as const,
              error: { message: 'tool call aborted before dispatch', info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } },
              content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
            },
          })),
          additionalContexts: [], concluded: false,
        })
      }, { once: true })
    })

    const run = await ctx.dagWorkflowEngine.start({ template: toolTemplate(), inputs: { message: 'hi' }, parent })
    await vi.waitFor(() => { expect(tools.batches).toHaveLength(1) })
    await run.cancel('stop')
    const result = await run.result

    expect(result).toMatchObject({ status: 'cancelled', nodeStates: { echo: 'cancelled' } })
    const [batch] = tools.batches
    expect(batch?.signal.aborted).toBe(true)
    await expect(answered).resolves.toMatchObject({
      results: [{ callId: batch?.calls?.[0]?.id, result: { isError: true, error: { info: { code: 'ABORTED_BEFORE_DISPATCH' } } } }],
    })
    const events = await eventsOf(ctx, result.runId)
    expect(events.filter(event => event.type === 'node.failed' || event.type === 'capability.failed')).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ type: 'run.cancelled', reason: 'stop' }))
  })
})
