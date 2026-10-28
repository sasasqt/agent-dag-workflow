import { describe, expect, it, vi } from 'vitest'
import { createDshToolGateway, type DshToolExecutionInput } from '../../src/adapters/dsh/index.js'

describe('DSH Tool gateway', () => {
  it('adapts the public tools.execute result contract', async () => {
    const execute = vi.fn(async (input: DshToolExecutionInput) => ({ isError: false as const, value: { received: input.arguments } }))
    const gateway = createDshToolGateway(execute)
    const signal = new AbortController().signal
    const authority = { session: 'test' }
    await expect(gateway.execute({
      runId: 'run-1', nodeId: 'node-1', invocationId: 'run-1:node-1:1', uses: 'search',
      inputs: { q: 'query' }, config: { uses: 'search' }, authority, signal,
    })).resolves.toEqual({ received: { q: 'query' } })
    expect(execute).toHaveBeenCalledWith({ callId: 'run-1:node-1:1', name: 'search', arguments: { q: 'query' }, agent: authority, signal })
  })

  // dsh-tools 0.2.2 ToolsService: execute(ToolBatchInput) → ToolBatchResult, identified by setExecutor.
  const request = (signal: AbortSignal) => ({
    runId: 'run-1', nodeId: 'node-1', invocationId: 'run-1:node-1:1', uses: 'search',
    inputs: { q: 'query' }, config: { uses: 'search' }, authority: { session: 'test' }, signal,
  })

  it('adapts the batch ToolsService of DSH 0.2.2 when given the tools service', async () => {
    const tools = {
      execute: vi.fn(async (input: { readonly calls: readonly { readonly id: string; readonly arguments: string }[] }) => ({
        results: input.calls.map(call => ({ callId: call.id, result: { isError: false as const, value: { received: JSON.parse(call.arguments) }, content: [] } })),
        additionalContexts: [],
        concluded: false,
      })),
      setExecutor: () => () => {},
    }
    const signal = new AbortController().signal

    await expect(createDshToolGateway(tools).execute(request(signal))).resolves.toEqual({ received: { q: 'query' } })
    expect(tools.execute).toHaveBeenCalledWith({
      calls: [{ type: 'tool-call', id: 'run-1:node-1:1', name: 'search', arguments: '{"q":"query"}' }],
      signal,
      agent: { session: 'test' },
    })
  })

  it('maps batch failures to DSH_TOOL_FAILED', async () => {
    const signal = new AbortController().signal
    const failure = new Error('Tool batch execution failed', { cause: new Error('scheduler crashed') })
    const rejected = { execute: async () => { throw failure }, setExecutor: () => () => {} }
    const unmatched = {
      execute: async () => ({ results: [{ callId: 'other', result: { isError: false as const, value: 1, content: [] } }], additionalContexts: [], concluded: false }),
      setExecutor: () => () => {},
    }

    await expect(createDshToolGateway(rejected).execute(request(signal))).rejects.toMatchObject({
      code: 'DSH_TOOL_FAILED', nodeId: 'node-1', message: 'Tool batch execution failed: scheduler crashed', cause: failure,
    })
    await expect(createDshToolGateway(unmatched).execute(request(signal))).rejects.toMatchObject({ code: 'DSH_TOOL_FAILED', nodeId: 'node-1' })
  })

  it('keeps the single-call ToolRuntime shape of DSH 0.2.0-rc.2 to 0.2.1-rc.4 when given the tools service', async () => {
    const tools = { execute: vi.fn(async (input: DshToolExecutionInput) => ({ isError: false as const, value: { received: input.arguments } })) }
    const signal = new AbortController().signal

    await expect(createDshToolGateway(tools).execute(request(signal))).resolves.toEqual({ received: { q: 'query' } })
    expect(tools.execute).toHaveBeenCalledWith({ callId: 'run-1:node-1:1', name: 'search', arguments: { q: 'query' }, agent: { session: 'test' }, signal })
  })
})
