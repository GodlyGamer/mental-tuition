"use client";

import { createContext } from "react";
import type { JobKind, JobRecord, MtViewMessage, SubagentArtifactData, SubagentResultMeta } from "@/src/core";

/**
 * Background-job observability channel (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * ONE central fetch (in Chat) reads GET /api/jobs?chatId=… and publishes
 * the list here — on mount, per jobs-changed announcement (the store emits
 * post-write), and on channel resync (push-architecture S4, 2026-10-02);
 * every job surface consumes it — the transcript dispatch cards (the ack
 * box with live status) and the sub-agents sidebar panel. Cards used to
 * each run their own poller on input-available parts; under the
 * ack-protocol the tool part resolves immediately, so the fetch moved
 * to the composition root and the cards became pure renderers of this data.
 */
export const JobsContext = createContext<JobRecord[]>([]);

/** The background jobs whose result shows IN PLACE (owner, 2026-10-27):
 *  the dispatch card turns into the result the moment the job finishes,
 *  even while a pending question holds back its delivery to the model. */
export const IN_PLACE_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(["research", "demo", "visual"]);

/** A delivered result steer, by the tool call it fulfills. */
export interface DeliveredArtifact {
	messageId: string;
	data: SubagentArtifactData;
}

/** Where job results render. `delivered`: the steer messages already in
 *  the transcript, by toolCallId (the dispatch card reads the delivered
 *  copy and its pinned UI state). `inPlace`: the in-place kinds' tool
 *  calls the transcript holds — their steer card stays silent, because
 *  the dispatch card already shows the result. */
export interface ArtifactPlacement {
	delivered: ReadonlyMap<string, DeliveredArtifact>;
	inPlace: ReadonlySet<string>;
}

export function artifactPlacement(messages: readonly MtViewMessage[]): ArtifactPlacement {
	const delivered = new Map<string, DeliveredArtifact>();
	const inPlace = new Set<string>();
	for (const m of messages) {
		const meta = (m.metadata as { subagentResult?: SubagentResultMeta } | undefined)?.subagentResult;
		const part = m.parts.find((p) => p.type === "data-subagent-artifact") as { data?: SubagentArtifactData } | undefined;
		if (meta?.toolCallId && part?.data) delivered.set(meta.toolCallId, { messageId: m.id, data: part.data });
		for (const p of m.parts) {
			const kind = p.type.startsWith("tool-") ? (p.type.slice("tool-".length) as JobKind) : null;
			const id = (p as { toolCallId?: string }).toolCallId;
			if (kind && IN_PLACE_KINDS.has(kind) && id) inPlace.add(id);
		}
	}
	return { delivered, inPlace };
}

export const ArtifactPlacementContext = createContext<ArtifactPlacement>({ delivered: new Map(), inPlace: new Set() });
