// Unit tests for the provider message translation — the riskiest part of the dual-protocol transport (the
// live-probe covers the tool-LESS path; this pins the tool round-trip in BOTH wire formats). Pure, no network.
import { toOpenAIMessages, toAnthropicMessage, type NeutralMessage } from './model-client';

const userMsg: NeutralMessage = { role: 'user', text: 'design an RC filter' };
const assistantMsg: NeutralMessage = {
    role: 'assistant',
    text: 'let me search',
    toolCalls: [{ id: 'call_1', name: 'search_parts', input: { query: '10k resistor' } }],
};
const toolMsg: NeutralMessage = { role: 'tool', results: [{ toolCallId: 'call_1', content: '[{"mpn":"RC0603"}]' }] };
const convo: NeutralMessage[] = [userMsg, assistantMsg, toolMsg];

describe('toOpenAIMessages', () => {
    it('prepends the system message and maps a user turn', () => {
        const out = toOpenAIMessages('SYS', [userMsg]) as any[];
        expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
        expect(out[1]).toEqual({ role: 'user', content: 'design an RC filter' });
    });

    it('maps an assistant tool call to OpenAI tool_calls (arguments are a JSON string)', () => {
        const out = toOpenAIMessages('SYS', convo) as any[];
        const assistant = out[2];
        expect(assistant.role).toBe('assistant');
        expect(assistant.content).toBe('let me search');
        expect(assistant.tool_calls).toEqual([
            {
                id: 'call_1',
                type: 'function',
                function: { name: 'search_parts', arguments: JSON.stringify({ query: '10k resistor' }) },
            },
        ]);
    });

    it('maps each tool result to its own role:tool message keyed by tool_call_id', () => {
        const out = toOpenAIMessages('SYS', convo) as any[];
        expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '[{"mpn":"RC0603"}]' });
    });

    it('omits tool_calls and nulls content for a plain assistant message', () => {
        const out = toOpenAIMessages('SYS', [{ role: 'assistant', text: '', toolCalls: [] }]) as any[];
        expect(out[1]).toEqual({ role: 'assistant', content: null });
        expect(out[1]).not.toHaveProperty('tool_calls');
    });
});

describe('toAnthropicMessage', () => {
    it('maps a user turn to a plain content string', () => {
        expect(toAnthropicMessage(userMsg)).toEqual({ role: 'user', content: 'design an RC filter' });
    });

    it('maps an assistant tool call to text + tool_use content blocks', () => {
        const m = toAnthropicMessage(assistantMsg) as any;
        expect(m.role).toBe('assistant');
        expect(m.content).toEqual([
            { type: 'text', text: 'let me search' },
            { type: 'tool_use', id: 'call_1', name: 'search_parts', input: { query: '10k resistor' } },
        ]);
    });

    it('maps tool results to tool_result blocks under a user turn', () => {
        const m = toAnthropicMessage(toolMsg) as any;
        expect(m.role).toBe('user');
        expect(m.content).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: '[{"mpn":"RC0603"}]' }]);
    });
});
