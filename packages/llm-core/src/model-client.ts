// Provider-agnostic model transport for llm-core.
//
// The rest of llm-core (prompts, the tool-use loop, JSON-repair, validation, telemetry) is protocol-
// neutral: it speaks in NeutralMessage / NeutralToolSchema / ModelReply. Two ModelClient implementations
// translate that neutral shape to a concrete wire format:
//   - AnthropicModelClient — the official @anthropic-ai/sdk (POST /v1/messages), for Claude-compatible
//     gateways (e.g. zentio). Auth via x-api-key; system carries a cache_control breakpoint.
//   - OpenAIModelClient    — an OpenAI-compatible chat-completions endpoint (POST <base>/chat/completions),
//     for GPT/Azure-compatible gateways (e.g. asvae). Raw fetch so we control the exact auth header.
//
// Which one is used is chosen at setup() from LLM_PROTOCOL (default 'anthropic', backward compatible), so a
// deployment can swap providers by config alone. Each client owns its ONE transient retry + wall-clock timeout.

import Anthropic from '@anthropic-ai/sdk';
import { isRetryableModelError } from './policy';

export type LlmProtocol = 'anthropic' | 'openai';

/** A tool the model may call (JSON-Schema input). Provider-neutral. */
export interface NeutralToolSchema {
    name: string;
    description: string;
    /** JSON Schema for the tool input (an object schema). */
    inputSchema: Record<string, unknown>;
}

export interface NeutralToolCall {
    id: string;
    name: string;
    input: Record<string, unknown>;
}

/** One conversation turn in provider-neutral form. */
export type NeutralMessage =
    | { role: 'user'; text: string }
    | { role: 'assistant'; text: string; toolCalls: NeutralToolCall[] }
    | { role: 'tool'; results: { toolCallId: string; content: string }[] };

export interface ModelRequest {
    system: string;
    messages: NeutralMessage[];
    tools?: NeutralToolSchema[];
    maxTokens: number;
    temperature?: number;
}

export interface ModelReply {
    /** Concatenated assistant text (may be empty when the turn is only tool calls). */
    text: string;
    toolCalls: NeutralToolCall[];
    inputTokens: number;
    outputTokens: number;
}

export interface ModelClient {
    readonly model: string;
    /**
     * One model round-trip. Retries ONCE on a transient error (5xx / timeout / connection drop), never on a
     * genuine 4xx. `onRequest` fires per BILLED HTTP call (attempt 1, and the retry as attempt 2) for cost
     * telemetry — it must not throw.
     */
    create(req: ModelRequest, onRequest?: (attempt: 1 | 2) => void): Promise<ModelReply>;
}

export interface ModelClientConfig {
    protocol: LlmProtocol;
    apiKey: string;
    baseUrl: string;
    model: string;
    userAgent: string;
    timeoutMs: number;
}

export function createModelClient(c: ModelClientConfig): ModelClient {
    return c.protocol === 'openai' ? new OpenAIModelClient(c) : new AnthropicModelClient(c);
}

// ---------------------------------------------------------------------------------------------------
// Anthropic (Claude-compatible): the original transport, now behind the neutral interface.
// ---------------------------------------------------------------------------------------------------

class AnthropicModelClient implements ModelClient {
    readonly model: string;
    private readonly client: Anthropic;

    constructor(c: ModelClientConfig) {
        this.model = c.model;
        this.client = new Anthropic({
            apiKey: c.apiKey,
            baseURL: c.baseUrl, // SDK appends /v1/messages
            defaultHeaders: { 'User-Agent': c.userAgent },
            timeout: c.timeoutMs,
            maxRetries: 0, // we own the single transient retry (below)
        });
    }

    async create(req: ModelRequest, onRequest?: (attempt: 1 | 2) => void): Promise<ModelReply> {
        const params: Anthropic.MessageCreateParamsNonStreaming = {
            model: this.model,
            max_tokens: req.maxTokens,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
            messages: req.messages.map(toAnthropicMessage),
            ...(req.tools?.length
                ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema })) }
                : {}),
        };
        const fire = (attempt: 1 | 2) => { try { onRequest?.(attempt); } catch { /* telemetry must not abort */ } };
        fire(1);
        let response: Anthropic.Message;
        try {
            response = await this.client.messages.create(params);
        } catch (e) {
            if (!isRetryableModelError(e)) throw e;
            await delay(1500);
            fire(2);
            response = await this.client.messages.create(params);
        }
        let text = '';
        const toolCalls: NeutralToolCall[] = [];
        for (const block of response.content) {
            if (block.type === 'text') text += (text ? '\n' : '') + block.text;
            else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
        }
        // Guard `usage` itself: a provider (or a test stub) may omit it — the old tokensUsed() tolerated that,
        // and the token count is only a budget signal, so a missing usage must degrade to 0, never throw.
        return { text: text.trim(), toolCalls, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 };
    }
}

export function toAnthropicMessage(m: NeutralMessage): Anthropic.MessageParam {
    if (m.role === 'user') return { role: 'user', content: m.text };
    if (m.role === 'assistant') {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const tc of m.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        return { role: 'assistant', content };
    }
    return { role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.content })) };
}

// ---------------------------------------------------------------------------------------------------
// OpenAI-compatible (chat completions): GPT/Azure-compatible gateways.
// ---------------------------------------------------------------------------------------------------

interface OpenAIChatResponse {
    choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

class OpenAIModelClient implements ModelClient {
    readonly model: string;
    private readonly url: string;
    private readonly apiKey: string;
    private readonly userAgent: string;
    private readonly timeoutMs: number;

    constructor(c: ModelClientConfig) {
        this.model = c.model;
        // baseUrl points at the API root that exposes /chat/completions, e.g. https://asvae.com/api/v1
        this.url = `${c.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        this.apiKey = c.apiKey;
        this.userAgent = c.userAgent;
        this.timeoutMs = c.timeoutMs;
    }

    async create(req: ModelRequest, onRequest?: (attempt: 1 | 2) => void): Promise<ModelReply> {
        const body = {
            model: this.model,
            messages: toOpenAIMessages(req.system, req.messages),
            // Token cap + temperature are intentionally OPTIONAL: some GPT/reasoning models reject `temperature`
            // and require `max_completion_tokens` over `max_tokens`. The proven-working baseline sends neither,
            // so we only include them when explicitly configured (temperature) — the cap rides on the newer key.
            ...(req.maxTokens ? { max_completion_tokens: req.maxTokens } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(req.tools?.length
                ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
                : {}),
        };
        const fire = (attempt: 1 | 2) => { try { onRequest?.(attempt); } catch { /* telemetry must not abort */ } };
        fire(1);
        let data: OpenAIChatResponse;
        try {
            data = await this.post(body);
        } catch (e) {
            if (!isOpenAiRetryable(e)) throw e;
            await delay(1500);
            fire(2);
            data = await this.post(body);
        }
        const message = data.choices?.[0]?.message;
        const toolCalls: NeutralToolCall[] = (message?.tool_calls ?? []).map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            input: safeParseObject(tc.function.arguments),
        }));
        return {
            text: (message?.content ?? '').trim(),
            toolCalls,
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
        };
    }

    private async post(body: unknown): Promise<OpenAIChatResponse> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let res: Response;
        try {
            res = await fetch(this.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'User-Agent': this.userAgent,
                    // asvae authenticates with x-api-key; also send the standard bearer for other gateways.
                    'x-api-key': this.apiKey,
                    authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (e) {
            // Network error / abort → mark retryable (mirrors the Anthropic transient path).
            throw new OpenAiHttpError(0, e instanceof Error ? e.message : String(e));
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            const detail = (await res.text().catch(() => '')).slice(0, 500);
            throw new OpenAiHttpError(res.status, detail || res.statusText);
        }
        return (await res.json()) as OpenAIChatResponse;
    }
}

export function toOpenAIMessages(system: string, messages: NeutralMessage[]): unknown[] {
    const out: unknown[] = [{ role: 'system', content: system }];
    for (const m of messages) {
        if (m.role === 'user') out.push({ role: 'user', content: m.text });
        else if (m.role === 'assistant') {
            out.push({
                role: 'assistant',
                content: m.text || null,
                ...(m.toolCalls.length
                    ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } })) }
                    : {}),
            });
        } else {
            // one OpenAI 'tool' message per result, keyed by tool_call_id
            for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
        }
    }
    return out;
}

/** Typed HTTP error so retry logic can distinguish transient (5xx / network status 0) from a real 4xx. */
export class OpenAiHttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = 'OpenAiHttpError';
    }
}

function isOpenAiRetryable(e: unknown): boolean {
    if (e instanceof OpenAiHttpError) return e.status === 0 || e.status >= 500 || e.status === 429;
    return false;
}

function safeParseObject(raw: string): Record<string, unknown> {
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
