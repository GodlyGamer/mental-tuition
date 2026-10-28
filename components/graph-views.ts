/**
 * The graph's two Hot Glass views (SPEC §9–10; boards Graph.html and
 * Neural.html), drawn by the single-canvas renderer (graph-canvas.ts):
 *
 *   CLOUD   each cluster is a density field of points around its centroid;
 *           topics are bright pinpoints; every link is a faint hairline;
 *           topics drift slowly; hovering a cluster pulls its points into
 *           swarms on the nearest topic and lights its links.
 *   NEURAL  a 3D wireframe cube (three nested outlines) holding a neural
 *           network: topics are bright neurons, smaller neurons fill each
 *           subject, synapses link them. Own 3D projection — the cube turns
 *           once per 80s, drags freely, hover pauses it.
 *
 * Models are SEEDED (a cluster's field is the same every load) and built
 * only when the data, visibility or density change; positions are read from
 * the live nodes each frame, so dragging and the physics settle just work.
 * The point and neuron budgets are scaled and capped (owner, 2026-10-27):
 * Standard and Lighter. Pure of the DOM except the draw functions' ctx.
 */

import type { CanvasData, CanvasNode } from "./graph-canvas.ts";

// ─── seeded randomness ──────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
	let s = seed | 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function hashSeed(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function gauss(r: () => number): number {
	const u = 1 - r();
	const v = r();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// ─── budgets ────────────────────────────────────────────────────────────────

export type Density = "standard" | "lighter";

/** points (cloud) / neurons (neural) per cluster: base + per·topics, capped
 *  per cluster, and the whole graph capped (scaled down proportionally). */
const BUDGETS = {
	cloud: {
		standard: { base: 40, per: 12, max: 400, total: 4000 },
		lighter: { base: 25, per: 8, max: 250, total: 2500 },
	},
	neural: {
		standard: { base: 6, per: 2, max: 60, total: 1200 },
		lighter: { base: 4, per: 1, max: 30, total: 600 },
	},
} as const;

export function budgetCounts(kind: "cloud" | "neural", topicCounts: readonly number[], density: Density): number[] {
	const b = BUDGETS[kind][density];
	const raw = topicCounts.map((t) => Math.min(b.max, b.base + b.per * t));
	const sum = raw.reduce((a, c) => a + c, 0);
	if (sum <= b.total) return raw;
	const f = b.total / sum;
	return raw.map((n) => Math.floor(n * f));
}

// ─── the shared graph the views draw ────────────────────────────────────────

export interface ViewTopic {
	id: string;
	label: string;
	node: CanvasNode;
	cluster: number;
	/** 0.45–1 by link count: sizes the pinpoint and its swarm. */
	w: number;
	deg: number;
	drift: Drift;
}
export interface ViewCluster {
	id: string;
	label: string;
	topics: number[];
	/** Links with an end in this cluster / with both ends in it. */
	links: number;
}
export interface ViewLink {
	a: number;
	b: number;
}
export interface ViewGraph {
	topics: ViewTopic[];
	clusters: ViewCluster[];
	links: ViewLink[];
}

/** One topic's slow wander: ±8px x / ±6px y (screen) on 16–28s loops. */
export interface Drift {
	px: number;
	py: number;
	phx: number;
	phy: number;
}
export const DRIFT_AX = 8;
export const DRIFT_AY = 6;

export function driftFor(id: string): Drift {
	const r = mulberry32(hashSeed(`drift:${id}`));
	return { px: 16 + r() * 12, py: 16 + r() * 12, phx: r() * Math.PI * 2, phy: r() * Math.PI * 2 };
}

export function driftOffset(d: Drift, nowMs: number): { x: number; y: number } {
	const t = nowMs / 1000;
	return {
		x: DRIFT_AX * Math.sin((2 * Math.PI * t) / d.px + d.phx),
		y: DRIFT_AY * Math.sin((2 * Math.PI * t) / d.py + d.phy),
	};
}

export function buildViewGraph(
	data: CanvasData,
	visible: ReadonlySet<string> | null,
	isImp: (id: string) => boolean,
): ViewGraph {
	const nodes = data.nodes.filter((n) => !isImp(n.id) && (!visible || visible.has(n.id)));
	const indexOf = new Map<string, number>();
	nodes.forEach((n, i) => indexOf.set(n.id, i));

	// Clusters: the data's own, then one catch-all for topics in none.
	const clusterOf = new Array<number>(nodes.length).fill(-1);
	const clusters: ViewCluster[] = [];
	for (const c of data.clusters) {
		const members = c.members.map((m) => indexOf.get(m)).filter((i): i is number => i !== undefined && clusterOf[i] === -1);
		if (members.length === 0) continue;
		const ci = clusters.length;
		for (const m of members) clusterOf[m] = ci;
		clusters.push({ id: c.id, label: (c.label ?? "").trim(), topics: members, links: 0 });
	}
	const loose = nodes.map((_, i) => i).filter((i) => clusterOf[i] === -1);
	if (loose.length > 0) {
		const ci = clusters.length;
		for (const m of loose) clusterOf[m] = ci;
		clusters.push({ id: "__ungrouped__", label: "", topics: loose, links: 0 });
	}

	// Links: the logical (imp-contracted) arrows when the data has them.
	const seen = new Set<string>();
	const links: ViewLink[] = [];
	for (const e of data.logicalEdges ?? data.edges) {
		const a = indexOf.get(e.from);
		const b = indexOf.get(e.to);
		if (a === undefined || b === undefined || a === b) continue;
		const key = a < b ? `${a}:${b}` : `${b}:${a}`;
		if (seen.has(key)) continue;
		seen.add(key);
		links.push({ a, b });
	}
	const deg = new Array<number>(nodes.length).fill(0);
	for (const l of links) {
		deg[l.a]!++;
		deg[l.b]!++;
		clusters[clusterOf[l.a]!]!.links++;
		if (clusterOf[l.b] !== clusterOf[l.a]) clusters[clusterOf[l.b]!]!.links++;
	}
	const maxDeg = Math.max(1, ...deg);
	const topics: ViewTopic[] = nodes.map((node, i) => ({
		id: node.id,
		label: node.label,
		node,
		cluster: clusterOf[i]!,
		w: 0.45 + 0.55 * (deg[i]! / maxDeg),
		deg: deg[i]!,
		drift: driftFor(node.id),
	}));
	return { topics, clusters, links };
}

// ─── cloud: geometry, model, hit test ───────────────────────────────────────

export interface ClusterGeo {
	cx: number;
	cy: number;
	/** The field's spread (world units): ~the board's σ 120×62 for a spread-out cluster. */
	sx: number;
	sy: number;
}

/** Centroid and spread from the topics' CURRENT positions (they move
 *  while the physics settles / a node is dragged). */
export function clusterGeometry(graph: ViewGraph): ClusterGeo[] {
	return graph.clusters.map((c) => {
		let cx = 0;
		let cy = 0;
		for (const i of c.topics) {
			cx += graph.topics[i]!.node.x;
			cy += graph.topics[i]!.node.y;
		}
		cx /= c.topics.length;
		cy /= c.topics.length;
		let vx = 0;
		let vy = 0;
		for (const i of c.topics) {
			const n = graph.topics[i]!.node;
			vx += (n.x - cx) ** 2;
			vy += (n.y - cy) ** 2;
		}
		const sdx = Math.sqrt(vx / c.topics.length);
		const sdy = Math.sqrt(vy / c.topics.length);
		return { cx, cy, sx: Math.max(30, 1.15 * sdx + 30), sy: Math.max(24, 1.15 * sdy + 24) };
	});
}

export interface CloudPoint {
	topic: number;
	cluster: number;
	/** Home offset from the centroid, in σ units. */
	hx: number;
	hy: number;
	/** Swarm offset around the nearest topic, screen px. */
	ex: number;
	ey: number;
	/** Point size, screen px (1.1–1.9). */
	size: number;
	/** Resting opacity: .12 + .68·falloff. */
	co: number;
	/** Stagger before the swarm moves, ms (0–140). */
	delay: number;
}

export function buildCloudPoints(graph: ViewGraph, density: Density): CloudPoint[] {
	const geo = clusterGeometry(graph);
	const counts = budgetCounts("cloud", graph.clusters.map((c) => c.topics.length), density);
	const points: CloudPoint[] = [];
	graph.clusters.forEach((c, ci) => {
		const g = geo[ci]!;
		const r = mulberry32(hashSeed(`cloud:${c.id}`));
		for (let i = 0; i < counts[ci]!; i++) {
			const hx = gauss(r);
			const hy = gauss(r);
			const x = g.cx + hx * g.sx;
			const y = g.cy + hy * g.sy;
			let near = c.topics[0]!;
			let best = Infinity;
			for (const ti of c.topics) {
				const n = graph.topics[ti]!.node;
				const d = (n.x - x) ** 2 + (n.y - y) ** 2;
				if (d < best) {
					best = d;
					near = ti;
				}
			}
			const sig = 2 + 3.5 * graph.topics[near]!.w;
			points.push({
				topic: near,
				cluster: ci,
				hx,
				hy,
				ex: gauss(r) * sig,
				ey: gauss(r) * sig,
				size: 1.1 + r() * 0.8,
				co: 0.12 + 0.68 * Math.exp(-(hx * hx) / 2 - (hy * hy) / 2),
				delay: Math.round(r() * 140),
			});
		}
	});
	return points;
}

/** The cluster whose (1.55σ) ellipse holds the world point, nearest centre first. */
export function clusterAt(geo: readonly ClusterGeo[], wx: number, wy: number): number | null {
	let best: number | null = null;
	let bestD = Infinity;
	geo.forEach((g, i) => {
		const d = ((wx - g.cx) / (1.55 * g.sx)) ** 2 + ((wy - g.cy) / (1.55 * g.sy)) ** 2;
		if (d <= 1 && d < bestD) {
			bestD = d;
			best = i;
		}
	});
	return best;
}

// ─── drawing helpers ────────────────────────────────────────────────────────

function rgba(hex: string, a: number): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return hex;
	const n = parseInt(m[1]!, 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export interface ViewColors {
	node: string;
	edge: string;
	label: string;
}

/** The spectrum the interaction ring uses (read from the theme tokens). */
export function spectrum(): string[] {
	const css = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
	const fallback = ["#ff5ad1", "#ffb547", "#f4ff7a", "#5dffb0", "#49e6ff", "#6a7bff", "#c86bff"];
	return fallback.map((c, i) => css?.getPropertyValue(`--mt-iri-${i + 1}`).trim() || c);
}

/** A conic spectrum ring (the §4 press language) around a point. `ctx` is in
 *  whatever space the point is in; `r` is the ring's radius there. */
export function drawSpectrumRing(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	r: number,
	width: number,
	nowMs: number,
	alpha: number,
	colors: readonly string[] = spectrum(),
): void {
	if (typeof ctx.createConicGradient !== "function") return;
	const g = ctx.createConicGradient(((nowMs / 3200) % 1) * Math.PI * 2, x, y);
	colors.forEach((c, i) => g.addColorStop(i / colors.length, c));
	g.addColorStop(1, colors[0]!);
	ctx.save();
	ctx.globalAlpha = alpha;
	ctx.strokeStyle = g;
	ctx.lineWidth = width;
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.stroke();
	ctx.restore();
}

const easeOut = (t: number) => 1 - (1 - clamp(t, 0, 1)) ** 3;

/** How long a swarm takes to gather (and how far the clock runs): the 650ms
 *  move plus the 140ms stagger. */
export const SWARM_MS = 650;
export const SWARM_CLOCK_MAX = SWARM_MS + 140;
const MIX_MS = 400;
const LABEL_DELAY_MS = 320;

export interface CloudDrawState {
	/** Screen px per world unit. */
	k: number;
	nowMs: number;
	/** 0…SWARM_CLOCK_MAX: runs up while a cluster is hovered, down after. */
	clock: number;
	/** The cluster being shown (hovered, or fading out). */
	shown: number | null;
	/** The topic under the pointer (spectrum ring). */
	hoverTopic: number | null;
	pressed: boolean;
	/** The "Cluster names" switch. */
	labels: boolean;
	/** Zoomed in far enough to name every topic of the shown cluster. */
	labelAll: boolean;
}

/** A crowded cluster names only its most-connected topics (and the one
 *  under the pointer) until the view is zoomed in. */
export const CLOUD_LABEL_CAP = 14;

export interface CloudFrame {
	/** The mono readout, e.g. "FLUIDS · 5 NODES · 9 LINKS". */
	readout: string;
}

/** Draws the Cloud view in WORLD space (the camera transform is set). */
export function drawCloud(
	ctx: CanvasRenderingContext2D,
	graph: ViewGraph,
	points: readonly CloudPoint[],
	st: CloudDrawState,
	colors: ViewColors,
	fontFamily: string,
): CloudFrame {
	const { k, nowMs } = st;
	const h = st.shown;
	const mix = h === null ? 0 : easeOut(st.clock / MIX_MS);
	const geo = clusterGeometry(graph);
	const pos = graph.topics.map((t) => {
		const d = driftOffset(t.drift, nowMs);
		return { x: t.node.x + d.x / k, y: t.node.y + d.y / k };
	});

	// Links: every one a faint hairline; the shown cluster's brighten.
	const buckets: { alpha: number; path: Path2D }[] = [
		{ alpha: 0.1 + (0.62 - 0.1) * mix, path: new Path2D() }, // inside the shown cluster
		{ alpha: 0.1 + (0.26 - 0.1) * mix, path: new Path2D() }, // touching it
		{ alpha: 0.1 + (0.04 - 0.1) * mix, path: new Path2D() }, // everything else
	];
	for (const l of graph.links) {
		const ca = graph.topics[l.a]!.cluster;
		const cb = graph.topics[l.b]!.cluster;
		const bucket = h === null ? 2 : ca === h && cb === h ? 0 : ca === h || cb === h ? 1 : 2;
		const p = buckets[h === null ? 2 : bucket]!.path;
		p.moveTo(pos[l.a]!.x, pos[l.a]!.y);
		p.lineTo(pos[l.b]!.x, pos[l.b]!.y);
	}
	ctx.lineWidth = 1 / k;
	ctx.lineCap = "round";
	for (const b of buckets) {
		ctx.strokeStyle = rgba(colors.edge, b.alpha);
		ctx.stroke(b.path);
	}

	// Points: home in the density field, or swarmed onto the nearest topic.
	ctx.fillStyle = colors.node;
	for (const p of points) {
		const hot = h !== null && p.cluster === h;
		const g = geo[p.cluster]!;
		const hx = g.cx + p.hx * g.sx;
		const hy = g.cy + p.hy * g.sy;
		const d = driftOffset(graph.topics[p.topic]!.drift, nowMs);
		let x = hx + d.x / k;
		let y = hy + d.y / k;
		let a = p.co;
		let s = p.size;
		if (h !== null) {
			if (hot) {
				const t = easeOut((st.clock - p.delay) / SWARM_MS);
				const tp = pos[p.topic]!;
				x += (tp.x + p.ex / k - x) * t;
				y += (tp.y + p.ey / k - y) * t;
				a = p.co + (0.95 - p.co) * t;
				s *= 1 + 0.15 * t;
			} else {
				a *= 1 - 0.65 * mix;
			}
		}
		const w = s / k;
		ctx.globalAlpha = a;
		ctx.fillRect(x - w / 2, y - w / 2, w, w);
	}
	ctx.globalAlpha = 1;

	// Topics: bright pinpoints, a soft white glow behind each.
	const glow = graph.topics.length <= 600;
	graph.topics.forEach((t, i) => {
		const hot = h !== null && t.cluster === h;
		const dim = h !== null && !hot;
		const sPx = hot ? 6 + 5 * t.w * mix + (3 + 3 * t.w) * (1 - mix) : 3 + 3 * t.w;
		const r = sPx / 2 / k;
		const a = dim ? 1 - 0.65 * mix : 1;
		const { x, y } = pos[i]!;
		if (glow) {
			const gr = r + (hot ? 12 + 10 * t.w : 6 + 8 * t.w) / k;
			const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, gr);
			g.addColorStop(0, rgba(colors.node, (hot ? 0.7 : 0.45) * a));
			g.addColorStop(1, rgba(colors.node, 0));
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc(x, y, gr, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = a;
		ctx.fillStyle = colors.node;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.globalAlpha = 1;
	});

	// The shown cluster's topic names fade in after the swarm starts.
	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	const labelA = h === null ? 0 : clamp((st.clock - LABEL_DELAY_MS) / 200, 0, 1);
	if (h !== null && labelA > 0.02) {
		ctx.font = `500 ${11 / k}px ${fontFamily}`;
		ctx.fillStyle = rgba(colors.label, labelA);
		const ids = graph.clusters[h]!.topics;
		const named = new Set(
			st.labelAll || ids.length <= CLOUD_LABEL_CAP
				? ids
				: [...ids].sort((a, b) => graph.topics[b]!.deg - graph.topics[a]!.deg).slice(0, CLOUD_LABEL_CAP),
		);
		if (st.hoverTopic !== null && graph.topics[st.hoverTopic]!.cluster === h) named.add(st.hoverTopic);
		for (const ti of named) {
			const name = graph.topics[ti]!.label;
			const { x, y } = pos[ti]!;
			ctx.fillText(name.length > 30 ? `${name.slice(0, 29)}…` : name, x, y + 12 / k);
		}
	}

	// Cluster names: mono caps under each cloud, fading as it is hovered.
	ctx.font = `400 ${11 / k}px ui-monospace, "Geist Mono", monospace`;
	(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "1.5px";
	graph.clusters.forEach((c, i) => {
		if (!c.label || !st.labels) return;
		const a = h === null ? 0.9 : h === i ? 0.9 * (1 - mix) : 0.35;
		if (a < 0.02) return;
		ctx.fillStyle = rgba(colors.label, a);
		ctx.fillText(c.label.toUpperCase().slice(0, 36), geo[i]!.cx, geo[i]!.cy + 1.45 * geo[i]!.sy);
	});
	(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";

	// The interaction ring on the topic under the pointer.
	if (st.hoverTopic !== null) {
		const { x, y } = pos[st.hoverTopic]!;
		const t = graph.topics[st.hoverTopic]!;
		const r = (6 + 5 * t.w) / k;
		drawSpectrumRing(ctx, x, y, r, (st.pressed ? 2.5 : 1.5) / k, nowMs, st.pressed ? 1 : 0.9);
	}

	const total = `${graph.topics.length} NODES · ${graph.clusters.length} CLUSTERS · ${graph.links.length} LINKS`;
	const c = h === null ? null : graph.clusters[h]!;
	return {
		readout: c ? `${(c.label || "UNGROUPED").toUpperCase()} · ${c.topics.length} NODES · ${c.links} LINKS` : total,
	};
}

// ─── neural: the 3D model ───────────────────────────────────────────────────

export interface NeuralNode {
	x: number;
	y: number;
	z: number;
	cluster: number;
	/** The topic's index, or -1 for a filler neuron. Topics come first. */
	topic: number;
	w: number;
}
export interface NeuralModel {
	nodes: NeuralNode[];
	topicCount: number;
	/** Topic–topic links (indices into nodes). */
	synapses: [number, number][];
	/** Each neuron's two nearest (indices into nodes). */
	neuronLinks: [number, number][];
	clusterLabels: { label: string; x: number; y: number; z: number }[];
}

export function buildNeural(graph: ViewGraph, density: Density): NeuralModel {
	const n = graph.topics.length;
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const t of graph.topics) {
		minX = Math.min(minX, t.node.x);
		maxX = Math.max(maxX, t.node.x);
		minY = Math.min(minY, t.node.y);
		maxY = Math.max(maxY, t.node.y);
	}
	const mx = (minX + maxX) / 2;
	const my = (minY + maxY) / 2;
	const half = Math.max(1, (maxX - minX) / 2, (maxY - minY) / 2);
	const norm = 0.82 / half;

	const zc = graph.clusters.map((c) => (mulberry32(hashSeed(`z:${c.id}`))() * 2 - 1) * 0.55);
	const nodes: NeuralNode[] = graph.topics.map((t, i) => {
		const r = mulberry32(hashSeed(`tz:${t.id}`));
		return {
			x: (t.node.x - mx) * norm,
			y: (t.node.y - my) * norm,
			z: clamp(zc[t.cluster]! + gauss(r) * 0.1, -0.92, 0.92),
			cluster: t.cluster,
			topic: i,
			w: t.w,
		};
	});

	const counts = budgetCounts("neural", graph.clusters.map((c) => c.topics.length), density);
	const clusterLabels: NeuralModel["clusterLabels"] = [];
	graph.clusters.forEach((c, ci) => {
		let cx = 0;
		let cy = 0;
		for (const ti of c.topics) {
			cx += nodes[ti]!.x;
			cy += nodes[ti]!.y;
		}
		cx /= c.topics.length;
		cy /= c.topics.length;
		let spread = 0;
		for (const ti of c.topics) spread += Math.hypot(nodes[ti]!.x - cx, nodes[ti]!.y - cy);
		spread /= c.topics.length;
		const sig = Math.max(0.1, 0.9 * spread + 0.06);
		const r = mulberry32(hashSeed(`neural:${c.id}`));
		for (let i = 0; i < counts[ci]!; i++) {
			nodes.push({
				x: clamp(cx + gauss(r) * sig, -0.94, 0.94),
				y: clamp(cy + gauss(r) * sig, -0.94, 0.94),
				z: clamp(zc[ci]! + gauss(r) * 0.14, -0.94, 0.94),
				cluster: ci,
				topic: -1,
				w: 0,
			});
		}
		clusterLabels.push({ label: c.label, x: cx, y: cy, z: zc[ci]! });
	});

	const synapses: [number, number][] = graph.links.map((l) => [l.a, l.b]);

	// Each neuron links to its 2 nearest in its own subject (topics included).
	const byCluster = new Map<number, number[]>();
	nodes.forEach((nd, i) => byCluster.set(nd.cluster, [...(byCluster.get(nd.cluster) ?? []), i]));
	const seen = new Set<string>();
	const neuronLinks: [number, number][] = [];
	for (let i = n; i < nodes.length; i++) {
		const a = nodes[i]!;
		const near: { j: number; d: number }[] = [];
		for (const j of byCluster.get(a.cluster) ?? []) {
			if (j === i) continue;
			const b = nodes[j]!;
			near.push({ j, d: (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 });
		}
		near.sort((p, q) => p.d - q.d);
		for (const { j } of near.slice(0, 2)) {
			const key = i < j ? `${i}:${j}` : `${j}:${i}`;
			if (seen.has(key)) continue;
			seen.add(key);
			neuronLinks.push([i, j]);
		}
	}
	return { nodes, topicCount: n, synapses, neuronLinks, clusterLabels };
}

export interface Projected {
	sx: number;
	sy: number;
	/** Depth: >0 is away from the viewer. */
	z: number;
	/** Perspective scale around 1. */
	s: number;
}

/** Rotate (yaw about Y, then pitch about X; radians) and project a unit-cube
 *  point to the screen: centre (cx, cy), cube half-extent `half` px. */
export function project(x: number, y: number, z: number, yaw: number, pitch: number, cx: number, cy: number, half: number): Projected {
	const x1 = x * Math.cos(yaw) + z * Math.sin(yaw);
	const z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
	const y2 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
	const z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch);
	const s = 1 / (1 + 0.16 * z2);
	return { sx: cx + x1 * half * s, sy: cy + y2 * half * s, z: z2, s };
}

/** Project every node of the model for one frame. */
export function projectModel(m: NeuralModel, yaw: number, pitch: number, cx: number, cy: number, half: number): Projected[] {
	return m.nodes.map((n) => project(n.x, n.y, n.z, yaw, pitch, cx, cy, half));
}

/** The topic under a screen point (nearest within its radius + a pad). */
export function neuralTopicAt(m: NeuralModel, proj: readonly Projected[], px: number, py: number): number | null {
	let best: number | null = null;
	let bestD = Infinity;
	for (let i = 0; i < m.topicCount; i++) {
		const p = proj[i]!;
		const r = (5 + 5 * m.nodes[i]!.w) * p.s + 7;
		const d = Math.hypot(px - p.sx, py - p.sy);
		if (d <= r && d < bestD) {
			bestD = d;
			best = i;
		}
	}
	return best;
}

export const CUBE_EDGE_PX = 440;
/** The three nested outlines: edge px at fit zoom and their opacities. */
export const CUBE_OUTLINES: readonly { edge: number; alpha: number }[] = [
	{ edge: 440, alpha: 0.34 },
	{ edge: 426, alpha: 0.16 },
	{ edge: 412, alpha: 0.08 },
];
/** One revolution per 80s. */
export const AUTO_TURN_RAD_PER_MS = (Math.PI * 2) / 80_000;
export const START_PITCH = (-14 * Math.PI) / 180;
export const DRAG_RAD_PER_PX = (0.35 * Math.PI) / 180;
export const KEY_TURN_RAD = (10 * Math.PI) / 180;
export const MAX_PITCH = (85 * Math.PI) / 180;

const CUBE_EDGES: [number, number][] = [
	[0, 1], [1, 3], [3, 2], [2, 0],
	[4, 5], [5, 7], [7, 6], [6, 4],
	[0, 4], [1, 5], [2, 6], [3, 7],
];
const CUBE_CORNERS: [number, number, number][] = [
	[-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
	[-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
];

export interface NeuralDrawState {
	yaw: number;
	pitch: number;
	cx: number;
	cy: number;
	/** Cube half-extent at the current zoom, px (= edge/2 × zoom). */
	half: number;
	nowMs: number;
	hoverTopic: number | null;
	pressed: boolean;
	haze: HTMLCanvasElement | null;
	/** The "Cluster names" switch. */
	labels: boolean;
}

/** The soft iridescent haze under the cube: a conic spectrum, heavily
 *  blurred, rendered once and blitted at .16. */
export function makeHaze(size: number): HTMLCanvasElement | null {
	if (typeof document === "undefined") return null;
	const c = document.createElement("canvas");
	c.width = c.height = size;
	const ctx = c.getContext("2d");
	if (!ctx || typeof ctx.createConicGradient !== "function") return null;
	const pad = size * 0.18;
	const g = ctx.createConicGradient(0, size / 2, size / 2);
	const colors = spectrum();
	colors.forEach((col, i) => g.addColorStop(i / colors.length, col));
	g.addColorStop(1, colors[0]!);
	ctx.filter = "blur(60px)";
	ctx.fillStyle = g;
	ctx.beginPath();
	ctx.ellipse(size / 2, size / 2, size / 2 - pad, size / 2 - pad, 0, 0, Math.PI * 2);
	ctx.fill();
	return c;
}

/** Draws the Neural view in SCREEN space (the camera transform is reset). */
export function drawNeural(
	ctx: CanvasRenderingContext2D,
	m: NeuralModel,
	graph: ViewGraph,
	st: NeuralDrawState,
	colors: ViewColors,
	fontFamily: string,
): { readout: string; proj: Projected[] } {
	const { yaw, pitch, cx, cy, half } = st;
	const proj = projectModel(m, yaw, pitch, cx, cy, half);
	const h = st.hoverTopic;

	// Neighbours of the hovered topic, for the lit synapses.
	const lit = new Set<number>();
	let hoverSynapses = 0;
	if (h !== null) {
		lit.add(h);
		for (const [a, b] of m.synapses) {
			if (a === h) {
				lit.add(b);
				hoverSynapses++;
			} else if (b === h) {
				lit.add(a);
				hoverSynapses++;
			}
		}
	}

	// The haze beneath the cube.
	if (st.haze) {
		const hs = half * 2.6;
		ctx.globalAlpha = 0.16;
		ctx.drawImage(st.haze, cx - hs / 2, cy + half * 0.55, hs, hs * 0.55);
		ctx.globalAlpha = 1;
	}

	// The cube: three nested outlines.
	ctx.lineWidth = 1;
	for (const o of CUBE_OUTLINES) {
		const f = o.edge / CUBE_EDGE_PX;
		const c = CUBE_CORNERS.map(([x, y, z]) => project(x * f, y * f, z * f, yaw, pitch, cx, cy, half));
		ctx.strokeStyle = rgba(colors.edge, o.alpha);
		ctx.beginPath();
		for (const [a, b] of CUBE_EDGES) {
			ctx.moveTo(c[a]!.sx, c[a]!.sy);
			ctx.lineTo(c[b]!.sx, c[b]!.sy);
		}
		ctx.stroke();
	}

	// Neuron links (.13) then synapses (.42, or lit .9 / dimmed on hover).
	ctx.strokeStyle = rgba(colors.edge, h === null ? 0.13 : 0.05);
	ctx.beginPath();
	for (const [a, b] of m.neuronLinks) {
		ctx.moveTo(proj[a]!.sx, proj[a]!.sy);
		ctx.lineTo(proj[b]!.sx, proj[b]!.sy);
	}
	ctx.stroke();
	const plain = new Path2D();
	const bright = new Path2D();
	for (const [a, b] of m.synapses) {
		const p = h !== null && (a === h || b === h) ? bright : plain;
		p.moveTo(proj[a]!.sx, proj[a]!.sy);
		p.lineTo(proj[b]!.sx, proj[b]!.sy);
	}
	ctx.strokeStyle = rgba(colors.edge, h === null ? 0.42 : 0.12);
	ctx.stroke(plain);
	ctx.strokeStyle = rgba(colors.edge, 0.9);
	ctx.stroke(bright);

	// Nodes, back to front: filler neurons (~2.6px, .7), topics (5–10px, glow).
	const order = proj.map((_, i) => i).sort((a, b) => proj[b]!.z - proj[a]!.z);
	const glow = m.topicCount <= 400;
	for (const i of order) {
		const nd = m.nodes[i]!;
		const p = proj[i]!;
		const depth = clamp(0.72 + 0.28 * (1 - (p.z + 1.7) / 3.4), 0.5, 1);
		if (nd.topic < 0) {
			ctx.globalAlpha = (h === null ? 0.7 : 0.3) * depth;
			ctx.fillStyle = colors.node;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, 1.3 * p.s, 0, Math.PI * 2);
			ctx.fill();
			continue;
		}
		const r = ((5 + 5 * nd.w) / 2) * p.s;
		const a = (h === null ? 1 : lit.has(i) ? 1 : 0.2) * depth;
		if (glow) {
			const gr = r + (6 + 8 * nd.w) * p.s;
			const g = ctx.createRadialGradient(p.sx, p.sy, r * 0.5, p.sx, p.sy, gr);
			g.addColorStop(0, rgba(colors.node, 0.5 * a));
			g.addColorStop(1, rgba(colors.node, 0));
			ctx.globalAlpha = 1;
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, gr, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = a;
		ctx.fillStyle = colors.node;
		ctx.beginPath();
		ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.globalAlpha = 1;

	// Labels always face the camera: the hovered topic and its neighbours,
	// plus each subject's name.
	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	ctx.font = `500 11px ${fontFamily}`;
	for (const i of lit) {
		const p = proj[i]!;
		ctx.fillStyle = rgba(colors.label, i === h ? 1 : 0.75);
		ctx.fillText(m.nodes[i]!.topic >= 0 ? (graph.topics[m.nodes[i]!.topic]!.label ?? "").slice(0, 30) : "", p.sx, p.sy + 12 * p.s);
	}
	ctx.font = `400 10.5px ui-monospace, "Geist Mono", monospace`;
	(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "1.5px";
	for (const cl of m.clusterLabels) {
		if (!cl.label || !st.labels) continue;
		const p = project(cl.x, cl.y, cl.z, yaw, pitch, cx, cy, half);
		ctx.fillStyle = rgba(colors.label, h === null ? 0.5 : 0.25);
		ctx.fillText(cl.label.toUpperCase().slice(0, 28), p.sx, p.sy + 22 * p.s);
	}
	(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";

	// The interaction ring.
	if (h !== null) {
		const p = proj[h]!;
		const r = ((5 + 5 * m.nodes[h]!.w) / 2 + 5) * p.s;
		drawSpectrumRing(ctx, p.sx, p.sy, r, st.pressed ? 2.5 : 1.5, st.nowMs, st.pressed ? 1 : 0.9);
	}

	const readout =
		h === null
			? `${m.nodes.length - m.topicCount} NEURONS · ${m.synapses.length} SYNAPSES`
			: `${graph.topics[h]!.label.toUpperCase().slice(0, 40)} · ${(graph.clusters[graph.topics[h]!.cluster]!.label || "UNGROUPED").toUpperCase().slice(0, 28)} · ${hoverSynapses} SYNAPSES`;
	return { readout, proj };
}
