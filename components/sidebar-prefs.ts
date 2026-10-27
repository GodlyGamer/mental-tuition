"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SidebarGrouping, SidebarKindFilter, UserSettings } from "@/src/core";

/**
 * The sidebar's remembered choices — TIME/MODULE grouping, the ALL · TEACH ·
 * PRACTICE filter, and which module groups are folded — kept in the
 * workspace settings file (settings.sidebar), so the PC and the laptop
 * share them (Hot Glass, owner 2026-10-27). Loaded once on mount; every
 * change saves the whole section (the section route replaces it).
 *
 * Migration: the filter used to live in this computer's localStorage. When
 * the settings file has no sidebar section yet, that old value seeds it
 * (once — the key is removed after the first successful save).
 */

export interface SidebarPrefs {
	grouping: SidebarGrouping;
	kindFilter: SidebarKindFilter;
	collapsedModules: string[];
}

export const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = { grouping: "time", kindFilter: "all", collapsedModules: [] };
const LEGACY_FILTER_KEY = "mt:session-kind-filter";

function legacyFilter(): SidebarKindFilter | null {
	try {
		const v = window.localStorage.getItem(LEGACY_FILTER_KEY);
		return v === "teach" || v === "all" || v === "practice" ? v : null;
	} catch {
		return null;
	}
}

export function useSidebarPrefs() {
	const [prefs, setPrefs] = useState<SidebarPrefs>(DEFAULT_SIDEBAR_PREFS);
	const prefsRef = useRef(prefs);
	prefsRef.current = prefs;

	const save = useCallback((next: SidebarPrefs) => {
		prefsRef.current = next;
		setPrefs(next);
		void fetch("/api/settings/sidebar", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(next),
		})
			.then((res) => {
				if (res.ok) {
					try {
						window.localStorage.removeItem(LEGACY_FILTER_KEY);
					} catch {
						// storage blocked: nothing to clean up
					}
				}
			})
			.catch(() => {
				// A failed save keeps the choice for this window.
			});
	}, []);

	useEffect(() => {
		let alive = true;
		fetch("/api/settings", { cache: "no-store" })
			.then((r) => r.json() as Promise<{ settings: UserSettings | null }>)
			.then((body) => {
				if (!alive) return;
				const stored = body.settings?.sidebar;
				if (stored) {
					setPrefs({
						grouping: stored.grouping ?? DEFAULT_SIDEBAR_PREFS.grouping,
						kindFilter: stored.kindFilter ?? DEFAULT_SIDEBAR_PREFS.kindFilter,
						collapsedModules: stored.collapsedModules ?? [],
					});
					return;
				}
				const legacy = legacyFilter();
				if (legacy && legacy !== DEFAULT_SIDEBAR_PREFS.kindFilter) save({ ...DEFAULT_SIDEBAR_PREFS, kindFilter: legacy });
			})
			.catch(() => {
				// Settings unreachable: the defaults stand.
			});
		return () => {
			alive = false;
		};
	}, [save]);

	const setGrouping = useCallback((grouping: SidebarGrouping) => save({ ...prefsRef.current, grouping }), [save]);
	const setKindFilter = useCallback((kindFilter: SidebarKindFilter) => save({ ...prefsRef.current, kindFilter }), [save]);
	const toggleModuleCollapsed = useCallback(
		(code: string) => {
			const current = prefsRef.current.collapsedModules;
			save({
				...prefsRef.current,
				collapsedModules: current.includes(code) ? current.filter((c) => c !== code) : [...current, code],
			});
		},
		[save],
	);

	return { prefs, setGrouping, setKindFilter, toggleModuleCollapsed };
}
