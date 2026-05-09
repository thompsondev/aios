import { ConfigService } from '@nestjs/config';
import { ClaudeAiService } from './claude-ai.service';

describe('ClaudeAiService (Anthropic SDK)', () => {
  function makeService(env: Record<string, string | undefined> = {}) {
    const cfg = {
      get: jest.fn((k: string) => env[k]),
    } as unknown as ConfigService;
    return new ClaudeAiService(cfg);
  }

  it('continues through pause_turn for generateText', async () => {
    const service = makeService({
      CLAUDE_API_KEY: 'test-key',
      CLAUDE_MODEL: 'claude-sonnet-4-6',
      CLAUDE_WEB_SEARCH_ENABLED: 'false',
      CLAUDE_WEB_FETCH_ENABLED: 'false',
    });

    const create = jest
      .fn()
      .mockResolvedValueOnce({
        stop_reason: 'pause_turn',
        content: [{ type: 'text', text: 'first chunk' }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'final answer' }],
      });

    (service as any).client = {
      messages: {
        create,
      },
    };

    const text = await service.generateText({
      prompt: 'Hello',
      messages: [{ role: 'assistant', content: 'prior' }],
    });

    expect(text).toBe('final answer');
    expect(create).toHaveBeenCalledTimes(2);

    const secondCall = create.mock.calls[1][0];
    expect(secondCall.messages[2]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'first chunk' }],
    });
  });

  it('streams text/tool events and continues pause_turn', async () => {
    const service = makeService({
      CLAUDE_API_KEY: 'test-key',
      CLAUDE_MODEL: 'claude-sonnet-4-6',
      CLAUDE_WEB_SEARCH_ENABLED: 'true',
      CLAUDE_WEB_FETCH_ENABLED: 'false',
    });

    const streamFactory = jest
      .fn()
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'content_block_start',
            content_block: { type: 'server_tool_use', name: 'web_search' },
          };
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'part-1 ' },
          };
        },
        finalMessage: jest.fn().mockResolvedValue({
          stop_reason: 'pause_turn',
          content: [{ type: 'text', text: 'assistant interim' }],
        }),
      }))
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'part-2' },
          };
        },
        finalMessage: jest.fn().mockResolvedValue({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'done' }],
        }),
      }));

    (service as any).client = {
      messages: {
        stream: streamFactory,
      },
    };

    const out: any[] = [];
    for await (const evt of service.streamGenerateText({
      prompt: 'Search this',
    })) {
      out.push(evt);
    }

    expect(out).toEqual([
      { type: 'tool-call', toolName: 'claude:web_search' },
      { type: 'text-delta', text: 'part-1 ' },
      { type: 'text-delta', text: 'part-2' },
    ]);

    expect(streamFactory).toHaveBeenCalledTimes(2);
    const secondCall = streamFactory.mock.calls[1][0];
    expect(secondCall.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'assistant interim' }],
    });
  });
});
