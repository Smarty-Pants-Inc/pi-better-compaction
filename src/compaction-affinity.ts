import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	resolveLatestNativeCompactionEntry,
	type LatestNativeCompactionResolution,
	type NativeCompactionEntryMatch,
} from "./details-store";
import { extractFreshAuthoritativePreamble } from "./payload-rewrite";
import type { ResponsesCompatibleRequestPayload } from "./runtime";
import { serializeMessagesToResponsesInput } from "./serializer";
import { NATIVE_COMPACTION_FALLBACK_SUMMARY, type NativeCompactionEntry } from "./types";

/**
 * Custom session entry recorded when the gateway answers 409 `compaction_affinity_missing`:
 * it cannot attribute the replayed signed `compaction` item to an account, so that
 * compaction is never replayed again (the entry survives a restart).
 */
export const COMPACTION_AFFINITY_RETIRED_ENTRY = "pi-better-compaction.compaction-affinity-missing";
const AFFINITY_CODE = "compaction_affinity_missing";

/** pi-ai's formatProviderError text for a 409 with a JSON body: "<prefix> (409): {...}" or "409: {...}". */
const STATUS_409_BODY = /^(?:[^\n]*?\(409\):|409:?)\s*(\{[\s\S]*\})\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasAffinityCode(error: unknown): boolean {
	return isRecord(error) && (error.code === AFFINITY_CODE || error.type === AFFINITY_CODE);
}

/** Exactly the gateway's 409 with code `compaction_affinity_missing` at `error.code` or `error.type`. */
export function isCompactionAffinityMissing(message: AgentMessage): boolean {
	if (message.role !== "assistant" || message.stopReason !== "error") return false;
	const match = STATUS_409_BODY.exec(message.errorMessage ?? "");
	if (!match) return false;
	let body: unknown;
	try {
		body = JSON.parse(match[1]!);
	} catch {
		return false;
	}
	// The openai SDK exposes the inner error object; a raw body keeps the `error` envelope.
	return hasAffinityCode(body) || (isRecord(body) && hasAffinityCode(body.error));
}

export function isAffinityRetired(entries: readonly SessionEntry[], compactionEntryId: string): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === COMPACTION_AFFINITY_RETIRED_ENTRY &&
			isRecord(entry.data) &&
			entry.data.compactionEntryId === compactionEntryId,
	);
}

export function hasPlainSummary(entry: NativeCompactionEntry): boolean {
	const summary = entry.summary?.trim();
	return !!summary && summary !== NATIVE_COMPACTION_FALLBACK_SUMMARY;
}

/**
 * Pi's context for the branch as if the retired compactions never happened: the
 * history they summarized (assistant answers, tool results, the kept window) comes
 * back from the branch transcript as plain messages.
 */
export function buildAffinityRetiredSessionMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const kept = entries.filter((entry) => !(entry.type === "compaction" && isAffinityRetired(entries, entry.id)));
	// getBranch() is root-to-leaf, so re-linking in order keeps the path without the retired entries.
	const chained = kept.map((entry, index) => ({ ...entry, parentId: index > 0 ? kept[index - 1]!.id : null }));
	return buildSessionContext(chained as SessionEntry[]).messages;
}

/**
 * The request to send while the latest compaction is retired. A real plain-text
 * summary means Pi's own payload is already safe: undefined. Otherwise the history
 * lives only in the rejected signed item, so send the full branch transcript rather
 * than a payload that silently drops it.
 */
export function buildAffinitySafePayload<TApi extends Api>(
	model: Model<TApi>,
	payload: ResponsesCompatibleRequestPayload,
	entries: readonly SessionEntry[],
	entry: NativeCompactionEntry,
): ResponsesCompatibleRequestPayload | undefined {
	if (hasPlainSummary(entry)) return undefined;
	const preamble = extractFreshAuthoritativePreamble(payload);
	if (!preamble) return undefined;
	return {
		...payload,
		...(preamble.instructions !== undefined ? { instructions: preamble.instructions } : {}),
		input: [
			...preamble.leadingInput,
			...serializeMessagesToResponsesInput(model, buildAffinityRetiredSessionMessages(entries)),
			...preamble.trailingInput,
		],
	};
}

/** The latest native compaction for a compaction request, unless the gateway retired it. */
export function resolveReplayableNativeCompaction(
	entries: readonly SessionEntry[],
	match: NativeCompactionEntryMatch,
): LatestNativeCompactionResolution | { ok: false; reason: "affinity-retired"; latestCompactionIndex: number; latestCompaction: CompactionEntry } {
	const latest = resolveLatestNativeCompactionEntry(entries, match);
	return latest.ok && isAffinityRetired(entries, latest.entry.id)
		? { ok: false, reason: "affinity-retired", latestCompactionIndex: latest.index, latestCompaction: latest.entry }
		: latest;
}
