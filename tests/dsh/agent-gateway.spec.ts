import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { executeDshAgent, type DshSubagentService } from '../../src/adapters/dsh/agent-gateway.js'
import * as DshWorkflowPlugin from '../../src/adapters/dsh/index.js'
import type { DshAgentLike, DshSubagentActivationRuntimeLike, DshSubagentActivationSpec } from '../../src/adapters/dsh/index.js'
import type { WorkflowAgentRequest, WorkflowTemplate } from '../../src/core/index.js'

const parent: DshAgentLike = { session: { append() {} } }
const completed = { output: [{ type: 'text', text: 'ok' }], structured: { answer: 'ok' }, stopReason: 'completed' }

function request(overrides: Partial<WorkflowAgentRequest> = {}): WorkflowAgentRequest {
  return {
    runId: 'run-1', nodeId: 'delegate', invocationId: 'run-1:delegate:1', prompt: 'Answer.', inputs: {},
    authority: parent, signal: new AbortController().signal, ...overrides,
  }
}

/** dsh-subagent >= 0.2.1-alpha.3: startActivation validates the schema like assertObjectJsonSchema. */
function activationRuntime(): DshSubagentActivationRuntimeLike & { readonly specs: DshSubagentActivationSpec[]; readonly dispose: ReturnType<typeof vi.fn> } {
  const specs: DshSubagentActivationSpec[] = []
  const dispose = vi.fn(async () => {})
  return {
    specs,
    dispose,
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }),
    async startActivation(spec) {
      specs.push(spec)
      if (spec.request.outputSchema !== undefined && spec.request.outputSchema.type !== 'object') {
        throw new Error('schema.type must be "object" (structured output is object-rooted)')
      }
      return { childId: 'child-1', result: Promise.resolve(completed), dispose }
    },
  }
}

describe('DSH agent gateway', () => {
  it('fails closed with AGENT_TARGET_UNAVAILABLE for `tools` on startActivation', async () => {
    const runtime = activationRuntime()

    await expect(executeDshAgent(runtime, request({ tools: ['web_search'] }), parent)).rejects.toMatchObject({
      code: 'AGENT_TARGET_UNAVAILABLE', nodeId: 'delegate', message: expect.stringContaining('toolFilter'),
    })
    expect(runtime.specs).toEqual([])
  })

  it('names the missing capabilities and never falls back to an incompatible provider', async () => {
    const start = vi.fn()
    const runtime = {
      list: () => ['acp'],
      getProvider: () => ({ capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false } }),
      start,
    }

    await expect(executeDshAgent(runtime, request({ outputSchema: { type: 'object' }, tools: [] }), parent)).rejects.toMatchObject({
      code: 'AGENT_TARGET_UNAVAILABLE', message: expect.stringContaining('requires outputSchema, toolFilter'),
    })
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects a subagents service without start or startActivation', async () => {
    const runtime = { list: () => ['spawn'], getProvider: () => undefined } as unknown as DshSubagentService

    await expect(executeDshAgent(runtime, request(), parent)).rejects.toMatchObject({ code: 'AGENT_TARGET_UNAVAILABLE' })
  })

  it('propagates a startActivation schema rejection without disposing anything', async () => {
    const runtime = activationRuntime()

    await expect(executeDshAgent(runtime, request({ outputSchema: { type: 'array' } }), parent)).rejects.toThrow(/object-rooted/)
    expect(runtime.specs).toHaveLength(1)
    expect(runtime.dispose).not.toHaveBeenCalled()
  })

  it('disposes an activation published after the signal already fired', async () => {
    const runtime = activationRuntime()
    const controller = new AbortController()
    controller.abort('cancelled during startup')

    await executeDshAgent(runtime, request({ signal: controller.signal }), parent)

    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-object-rooted outputSchema at compile time before any child starts', async () => {
    const ctx = new Context()
    class Tools extends Service {
      constructor(ctx: Context) { super(ctx, 'tools') }
      register() { return () => {} }
      schemas() { return [] }
      async execute() { return { results: [] } }
      setExecutor() { return () => {} }
    }
    const runtime = activationRuntime()
    class Subagents extends Service {
      constructor(ctx: Context) { super(ctx, 'subagents') }
      list() { return runtime.list() }
      getProvider(name: string) { return runtime.getProvider(name) }
      startActivation(spec: DshSubagentActivationSpec) { return runtime.startActivation(spec) }
    }
    class Approval extends Service { constructor(ctx: Context) { super(ctx, 'approval') } }
    class Skills extends Service {
      constructor(ctx: Context) { super(ctx, 'skills') }
      register() { return () => {} }
    }
    for (const plugin of [Tools, Subagents, Approval, Skills]) await ctx.plugin(plugin)
    await ctx.plugin(DshWorkflowPlugin)
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'array-schema', name: 'Array schema' },
      spec: {
        requires: [{ kind: 'capability', uses: 'gateway.agent.execute' }],
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object' },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'delegate', uses: 'agent.run@1', with: { prompt: 'List.', outputSchema: { type: 'array' } }, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
        ],
        edges: [{ id: 'a', source: 'start', target: 'delegate' }, { id: 'b', source: 'delegate', target: 'end' }],
        outputs: {},
      },
    }

    await expect(ctx.dagWorkflowEngine.start({ template, inputs: {}, parent })).rejects.toThrow(/object-rooted/)
    expect(runtime.specs).toEqual([])
  })
})
