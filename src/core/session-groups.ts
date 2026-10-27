/**
 * The sidebar's session groupings (Hot Glass, SPEC §8): TIME buckets
 * (Pinned / Today / Yesterday / This week / This month / Older, by
 * `updatedAt`) and MODULE groups ("1M1 · Mechanics · 4", sessions without a
 * module under "No module"). Pure: the sidebar renders what these return.
 */

export interface GroupableSession {
	id: string;
	updatedAt: string;
	pinned?: boolean;
	module?: string;
}

export type TimeBucket = "pinned" | "today" | "yesterday" | "this-week" | "this-month" | "older";

export const TIME_BUCKET_LABEL: Record<TimeBucket, string> = {
	pinned: "Pinned",
	today: "Today",
	yesterday: "Yesterday",
	"this-week": "This week",
	"this-month": "This month",
	older: "Older",
};

const TIME_BUCKET_ORDER: TimeBucket[] = ["pinned", "today", "yesterday", "this-week", "this-month", "older"];

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Which bucket a session falls in: pinned beats the clock; then local
 *  calendar days back — today, yesterday, 2–6 days = this week, the same
 *  calendar month = this month, everything else older. */
export function timeBucket(chat: GroupableSession, now = new Date()): TimeBucket {
	if (chat.pinned) return "pinned";
	const updated = new Date(chat.updatedAt);
	const days = Math.round((startOfDay(now) - startOfDay(updated)) / DAY_MS);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return "this-week";
	if (updated.getFullYear() === now.getFullYear() && updated.getMonth() === now.getMonth()) return "this-month";
	return "older";
}

export interface SessionGroup<T> {
	/** Stable key: the bucket id, or the module code ("" = no module). */
	key: string;
	label: string;
	items: T[];
}

/** Time groups in display order; empty buckets are dropped, each group
 *  keeps the caller's order (the list arrives newest first). */
export function groupByTime<T extends GroupableSession>(chats: readonly T[], now = new Date()): SessionGroup<T>[] {
	const by = new Map<TimeBucket, T[]>();
	for (const chat of chats) {
		const bucket = timeBucket(chat, now);
		by.set(bucket, [...(by.get(bucket) ?? []), chat]);
	}
	return TIME_BUCKET_ORDER.flatMap((bucket) => {
		const items = by.get(bucket);
		return items ? [{ key: bucket, label: TIME_BUCKET_LABEL[bucket], items }] : [];
	});
}

/** The module heading: "1M1 · Mechanics" (name optional); the count is the
 *  caller's to append. */
export function moduleLabel(code: string, name: string | null | undefined): string {
	return name ? `${code} · ${name}` : code;
}

/** Module groups: modules by code, then "No module" last. Within a group,
 *  pinned sessions come first, the rest keep the caller's order. */
export function groupByModule<T extends GroupableSession>(
	chats: readonly T[],
	names: Readonly<Record<string, string | null | undefined>> = {},
): SessionGroup<T>[] {
	const by = new Map<string, T[]>();
	for (const chat of chats) {
		const key = chat.module ?? "";
		by.set(key, [...(by.get(key) ?? []), chat]);
	}
	const pinnedFirst = (items: T[]) => [...items.filter((c) => c.pinned), ...items.filter((c) => !c.pinned)];
	const codes = [...by.keys()].filter((k) => k !== "").sort((a, b) => a.localeCompare(b));
	const groups: SessionGroup<T>[] = codes.map((code) => ({
		key: code,
		label: moduleLabel(code, names[code]),
		items: pinnedFirst(by.get(code)!),
	}));
	const none = by.get("");
	if (none) groups.push({ key: "", label: "No module", items: pinnedFirst(none) });
	return groups;
}
