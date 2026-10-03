import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compact, convertToLlm } from "@earendil-works/pi-coding-agent";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	TextContent,
	ThinkingContent,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ResponsesCompatibleRequestPayload } from "./runtime";

/**
 * pi stopped exporting the CompactionPreparation type name in 0.80.x, but it is still
 * structurally the first argument of the exported compact(). Derive it from there so we
 * track pi's shape without depending on a private export.
 */
type CompactionPreparation = Parameters<typeof compact>[0];

/**
 * Decision for T4: keep a narrow local Responses wire serializer.
 *
 * Why this is sufficient for v1:
 * - we only target same-model OpenAI Responses-compatible requests
 * - we only need Pi's current supported message semantics (assistant phase,
 *   reasoning signatures, tool call/result pairing, image blocks)
 * - the Responses wire serializer stays narrow; message normalization and tool
 *   result accounting delegate to Pi's exported provider transform
 *
 * Message normalization/tool pairing uses Pi's exported transformMessages(), not
 * a local implementation. The helpers below mirror the same-model Responses wire
 * rules closely so later tasks can compare their output against captured
 * before_provider_request payload artifacts.
 */
export const COMPACTION_SERIALIZER_STRATEGY = "local-same-model-responses-serializer" as const;

export type CompactionSerializerStrategy = typeof COMPACTION_SERIALIZER_STRATEGY;
export type AssistantPhase = "commentary" | "final_answer";

type ResponsesTextInputItem = {
	type: "input_text";
	text: string;
};

type ResponsesImageInputItem = {
	type: "input_image";
	detail: "auto";
	image_url: string;
};

export type ResponsesInputContentItem = ResponsesTextInputItem | ResponsesImageInputItem;

export type ResponsesInputMessageItem = {
	role: "user" | "developer" | "system";
	content: ResponsesInputContentItem[] | string;
};

export type ResponsesAssistantOutputItem = {
	type: "message";
	role: "assistant";
	content: Array<{
		type: "output_text";
		text: string;
		annotations: [];
	}>;
	status: "completed";
	id: string;
	phase?: AssistantPhase;
};

export type ResponsesFunctionCallItem = {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
};

export type ResponsesFunctionCallOutputItem = {
	type: "function_call_output";
	call_id: string;
	output: ResponsesInputContentItem[] | string;
};

export type ResponsesReasoningItem = Record<string, unknown>;

export type ResponsesInputItem =
	| ResponsesInputMessageItem
	| ResponsesAssistantOutputItem
	| ResponsesFunctionCallItem
	| ResponsesFunctionCallOutputItem
	| ResponsesReasoningItem;

export type NativeCompactionRequestBody = {
	model: string;
	input: ResponsesInputItem[];
	instructions: string;
	/**
	 * Optional passthrough fields mirroring the latest codex_rs CompactionInput.
	 * Sourced from the most recent provider request payload when available;
	 * undefined fields are omitted from the serialized JSON body.
	 */
	tools?: unknown[];
	parallel_tool_calls?: boolean;
	reasoning?: Record<string, unknown>;
	service_tier?: string;
	prompt_cache_key?: string;
	text?: Record<string, unknown>;
};

export type SerializeResponsesMessagesOptions = {
	instructions?: string;
	includeInstructionsInInput?: boolean;
};

export type ResponsesParityReport = {
	ok: boolean;
	actual: string[];
	expected: string[];
	mismatches: string[];
};

type ParsedTextSignature = {
	id: string;
	phase?: AssistantPhase;
};

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export function collectCompactionWindowMessages(preparation: CompactionPreparation): AgentMessage[] {
	return [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
}

export function serializeCompactionPreparationToRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	preparation: CompactionPreparation;
	instructions: string;
}): NativeCompactionRequestBody {
	return serializeMessagesToCompactRequest({
		model: args.model,
		messages: collectCompactionWindowMessages(args.preparation),
		instructions: args.instructions,
	});
}

export function serializeMessagesToCompactRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	messages: AgentMessage[];
	instructions: string;
}): NativeCompactionRequestBody {
	return {
		model: args.model.id,
		input: serializeMessagesToResponsesInput(args.model, args.messages),
		instructions: sanitizeSurrogates(args.instructions),
	};
}

export function serializeMessagesToResponsesInput<TApi extends Api>(
	model: Model<TApi>,
	messages: AgentMessage[],
	options: SerializeResponsesMessagesOptions = {},
): ResponsesInputItem[] {
	// Retain our legacy session-file boundary guard: Pi's provider transform
	// expects typed block arrays before it downgrades unsupported tool images.
	const llmMessages = convertToLlm(messages).map((message) => message.role === "toolResult"
		? { ...message, content: normalizeToolResultContent(message.content) }
		: message);
	// Both Pi Responses providers default supportsMidConvoSystemMessages to false.
	// In that mode they collapse every system delta into the authoritative leading
	// prompt/instructions and remove it from conversation input *before* message
	// transformation. Our caller already supplies that fresh provider-authored
	// preamble (or ctx.getSystemPrompt() for compact requests), so do not rebuild it
	// from potentially stale persisted text or emit those folded deltas again.
	const supportsMidConvoSystemMessages = model.compat && "supportsMidConvoSystemMessages" in model.compat
		&& model.compat.supportsMidConvoSystemMessages === true;
	const transcriptMessages = supportsMidConvoSystemMessages
		? llmMessages
		: llmMessages.filter((message) => message.role !== "system");
	// Use the provider's own transform: system updates are held until pending
	// actual/synthetic tool results close, including the end-of-transcript flush.
	// This serializer targets same-model replay, so no cross-provider ID adapter
	// is needed (Pi invokes that adapter only for a different source model).
	const transformedMessages = transformMessages(transcriptMessages, model);
	const input: ResponsesInputItem[] = [];

	if (options.includeInstructionsInInput && options.instructions) {
		input.push({
			role: model.reasoning ? "developer" : "system",
			content: sanitizeSurrogates(options.instructions),
		});
	}

	let messageIndex = 0;
	for (const message of transformedMessages) {
		if (message.role === "system") {
			// The leading persisted prompt is already supplied through instructions.
			// Later system messages patch the transcript (pi 1.0 MCP sections).
			if (messageIndex > 0) {
				const parts = [typeof message.content === "string"
					? message.content
					: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")];
				// Mirror pi 1.0 renderSystemMessageUpdate framing locally; older peers
				// need not export that newly public helper.
				for (const [name, value] of Object.entries(message.sections ?? {})) {
					parts.push(value === null
						? `Removed system prompt section "${name}".`
						: `Updated system prompt section "${name}":\n\n${value}`);
				}
				const text = parts.filter((part) => part.length > 0).join("\n\n");
				if (text.length > 0) {
					input.push({
						role: model.reasoning && !(model.compat && "supportsDeveloperRole" in model.compat && model.compat.supportsDeveloperRole === false)
							? "developer" : "system",
						content: sanitizeSurrogates(text),
					});
				}
			}
			messageIndex++;
			continue;
		}

		if (message.role === "user") {
			const item = serializeUserMessage(message, model);
			if (item) {
				input.push(item);
			}
			messageIndex++;
			continue;
		}

		if (message.role === "assistant") {
			const items = serializeAssistantMessage(message, messageIndex);
			if (items.length > 0) {
				input.push(...items);
			}
			messageIndex++;
			continue;
		}

		if (message.role === "toolResult") {
			input.push(serializeToolResultMessage(message, model));
			messageIndex++;
			continue;
		}

		// Unknown session roles carry no tool output; never serialize them as tool results.
		messageIndex++;
	}

	return input;
}

export function createResponsesInputParitySignature(input: readonly unknown[]): string[] {
	return input.map(describeResponsesInputItem);
}

export function compareResponsesInputParity(actual: readonly unknown[], expected: readonly unknown[]): ResponsesParityReport {
	const actualSignature = createResponsesInputParitySignature(actual);
	const expectedSignature = createResponsesInputParitySignature(expected);
	const maxLength = Math.max(actualSignature.length, expectedSignature.length);
	const mismatches: string[] = [];

	for (let index = 0; index < maxLength; index++) {
		const actualValue = actualSignature[index];
		const expectedValue = expectedSignature[index];
		if (actualValue !== expectedValue) {
			mismatches.push(`index ${index}: expected ${expectedValue ?? "<missing>"}, got ${actualValue ?? "<missing>"}`);
		}
	}

	return {
		ok: mismatches.length === 0,
		actual: actualSignature,
		expected: expectedSignature,
		mismatches,
	};
}

export function compareCompactRequestToPayload(
	request: NativeCompactionRequestBody,
	payload: Pick<ResponsesCompatibleRequestPayload, "model" | "input" | "instructions">,
): ResponsesParityReport {
	const parity = compareResponsesInputParity(request.input, payload.input);
	const mismatches = [...parity.mismatches];

	if (payload.model !== request.model) {
		mismatches.unshift(`model: expected ${payload.model}, got ${request.model}`);
	}

	if ((payload.instructions ?? "") !== request.instructions) {
		mismatches.unshift("instructions: expected serialized instructions to match payload instructions");
	}

	return {
		ok: mismatches.length === 0,
		actual: parity.actual,
		expected: parity.expected,
		mismatches,
	};
}

function serializeUserMessage<TApi extends Api>(
	message: UserMessage,
	model: Model<TApi>,
): ResponsesInputMessageItem | undefined {
	const contentItems = normalizeUserContent(message.content).flatMap((item) => serializeUserContentItem(item, model));
	if (contentItems.length === 0) {
		return undefined;
	}

	return {
		role: "user",
		content: contentItems,
	};
}

function serializeUserContentItem<TApi extends Api>(
	item: TextContent | ImageContent,
	model: Model<TApi>,
): ResponsesInputContentItem[] {
	if (item.type === "text") {
		return [{ type: "input_text", text: sanitizeSurrogates(item.text) }];
	}

	if (!model.input.includes("image")) {
		return [];
	}

	return [
		{
			type: "input_image",
			detail: "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		},
	];
}

function serializeAssistantMessage(message: AssistantMessage, messageIndex: number): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];

	for (const block of message.content) {
		if (block.type === "thinking") {
			const reasoningItem = parseReasoningItem(block);
			if (reasoningItem) {
				items.push(reasoningItem);
			}
			continue;
		}

		if (block.type === "text") {
			const signature = parseTextSignature(block.textSignature);
			items.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
				status: "completed",
				id: normalizeAssistantMessageId(signature?.id, messageIndex),
				phase: signature?.phase,
			});
			continue;
		}

		const [callId, rawItemId] = block.id.split("|");
		items.push({
			type: "function_call",
			id: rawItemId,
			call_id: callId,
			name: block.name,
			arguments: JSON.stringify(block.arguments),
		});
	}

	return items;
}

function serializeToolResultMessage<TApi extends Api>(
	message: ToolResultMessage,
	model: Model<TApi>,
): ResponsesFunctionCallOutputItem {
	const [callId] = (message.toolCallId ?? "").split("|");
	const contentItems = normalizeToolResultContent(message.content);
	const textOutput = contentItems
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => sanitizeSurrogates(item.text))
		.join("\n");
	const hasImages = contentItems.some((item) => item.type === "image");
	const hasText = textOutput.length > 0;

	if (hasImages && model.input.includes("image")) {
		const output: ResponsesInputContentItem[] = [];
		if (hasText) {
			output.push({ type: "input_text", text: textOutput });
		}
		for (const item of contentItems) {
			if (item.type !== "image") {
				continue;
			}
			output.push({
				type: "input_image",
				detail: "auto",
				image_url: `data:${item.mimeType};base64,${item.data}`,
			});
		}
		return {
			type: "function_call_output",
			call_id: callId,
			output,
		};
	}

	return {
		type: "function_call_output",
		call_id: callId,
		output: hasText ? textOutput : "(see attached image)",
	};
}

function normalizeUserContent(content: UserMessage["content"]): Array<TextContent | ImageContent> {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * Session files are parsed without validation and older Pi versions persisted
 * tool results with string `content`, so normalize defensively instead of
 * assuming an array (mirrors normalizeUserContent above).
 */
function normalizeToolResultContent(
	content: ToolResultMessage["content"] | string | null | undefined,
): Array<TextContent | ImageContent> {
	if (typeof content === "string") {
		return content.length > 0 ? [{ type: "text", text: content }] : [];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	return content.filter(
		(item): item is TextContent | ImageContent =>
			item != null && (item.type === "text" || item.type === "image"),
	);
}

function parseReasoningItem(block: ThinkingContent): ResponsesReasoningItem | undefined {
	if (!block.thinkingSignature) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(block.thinkingSignature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as ResponsesReasoningItem;
	} catch {
		return undefined;
	}
}

function parseTextSignature(signature: string | undefined): ParsedTextSignature | undefined {
	if (!signature) {
		return undefined;
	}

	if (!signature.startsWith("{")) {
		return { id: signature };
	}

	try {
		const parsed = JSON.parse(signature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}

		const record = parsed as Record<string, unknown>;
		if (record.v !== 1 || typeof record.id !== "string") {
			return undefined;
		}

		return {
			id: record.id,
			phase:
				record.phase === "commentary" || record.phase === "final_answer"
					? record.phase
					: undefined,
		};
	} catch {
		return undefined;
	}
}

function normalizeAssistantMessageId(id: string | undefined, messageIndex: number): string {
	if (!id) {
		return `msg_${messageIndex}`;
	}

	if (id.length <= 64) {
		return id;
	}

	return `msg_${createHash("sha1").update(id).digest("hex").slice(0, 12)}`;
}

function describeResponsesInputItem(item: unknown): string {
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		return typeof item;
	}

	const record = item as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : undefined;
	if (type === "message") {
		const phase =
			record.phase === "commentary" || record.phase === "final_answer"
				? `:${record.phase}`
				: "";
		return `message:${typeof record.role === "string" ? record.role : "unknown"}${phase}`;
	}

	if (type === "function_call") {
		return `function_call:${typeof record.name === "string" ? record.name : "unknown"}`;
	}

	if (type === "function_call_output") {
		return "function_call_output";
	}

	if (type === "reasoning") {
		return "reasoning";
	}

	if (typeof record.role === "string") {
		const content = Array.isArray(record.content) ? `[${record.content.length}]` : "";
		return `input:${record.role}${content}`;
	}

	return type ? `item:${type}` : "object";
}
