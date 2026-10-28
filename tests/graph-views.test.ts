import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	AUTO_TURN_RAD_PER_MS,
	budgetCounts,
	buildCloudPoints,
	buildNeural,
	buildViewGraph,
	clusterAt,
	clusterGeometry,
	driftOffset,
	driftFor,
	hashSeed,
	mulberry32,
	neuralTopicAt,
	project,
	projectModel,
	START_PITCH,
} from "../components/graph-views.ts";
import type { CanvasData } from "../components/graph-canvas.ts";

const node = (id: string, x: number, y: number) => ({ id, x, y, label: id.toUpperCase() });
const data = (over: Partial<CanvasData> = {}): CanvasData => ({
	nodes: [node("a", 0, 0), node("b", 60, 10), node("c", 30, 50), node("d", 400, 400), node("e", 430, 380), node("arg_1", 20, 20)],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
		{ from: "a", to: "c" },
		{ from: "d", to: "e" },
		{ from: "c", to: "d" },
		{ from: "b", to: "a" },
	],
	clusters: [
		{ id: "k1", label: "Fluids", members: ["a", "b", "c", "arg_1"] },
		{ id: "k2", label: "Structures", members: ["d", "e"] },
	],
	colors: { node: "#ffffff", edge: "#c8c8cc", label: "#dddddd", hoverText: "#ffffff" },
	fontFamily: "sans-serif",
	...over,
});
const isImp = (id: string) => id.startsWith("arg_");

describe("point budgets (owner, 2026-10-27)", () => {
	it("scales with topics and caps each cluster", () => {
		assert.deepEqual(budgetCounts("cloud", [5, 100], "standard"), [100, 400]);
		assert.deepEqual(budgetCounts("neural", [5, 100], "standard"), [16, 60]);
		assert.deepEqual(budgetCounts("cloud", [5, 100], "lighter"), [65, 250]);
		assert.deepEqual(budgetCounts("neural", [5, 100], "lighter"), [9, 30]);
	});

	it("caps the whole graph by scaling every cluster down", () => {
		const many = new Array<number>(40).fill(100);
		const standard = budgetCounts("cloud", many, "standard");
		assert.ok(standard.reduce((a, c) => a + c, 0) <= 4000);
		assert.ok(standard.every((n) => n > 0 && n < 400), "scaled, not zeroed");
		assert.ok(budgetCounts("cloud", many, "lighter").reduce((a, c) => a + c, 0) <= 2500);
		assert.ok(budgetCounts("neural", many, "standard").reduce((a, c) => a + c, 0) <= 1200);
		assert.ok(budgetCounts("neural", many, "lighter").reduce((a, c) => a + c, 0) <= 600);
	});
});

describe("the seeded models", () => {
	it("mulberry32 and hashSeed are deterministic", () => {
		const a = mulberry32(hashSeed("x"));
		const b = mulberry32(hashSeed("x"));
		assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
		assert.notEqual(hashSeed("x"), hashSeed("y"));
	});

	it("builds topics without the invisible imp nodes, links without duplicates, and weights by links", () => {
		const g = buildViewGraph(data(), null, isImp);
		assert.deepEqual(g.topics.map((t) => t.id), ["a", "b", "c", "d", "e"]);
		assert.equal(g.links.length, 5, "a–b / b–a collapse to one");
		const w = Object.fromEntries(g.topics.map((t) => [t.id, t.w]));
		assert.ok(w.c! > w.e!, "more links, bigger pinpoint");
		assert.ok(g.topics.every((t) => t.w >= 0.45 && t.w <= 1));
		assert.deepEqual(g.clusters.map((c) => [c.label, c.topics.length]), [["Fluids", 3], ["Structures", 2]]);
	});

	it("uses the logical (imp-contracted) arrows when the data has them", () => {
		const g = buildViewGraph(data({ logicalEdges: [{ from: "a", to: "e" }] }), null, isImp);
		assert.equal(g.links.length, 1);
	});

	it("honours visibility, drops emptied clusters, and groups loose topics together", () => {
		const g = buildViewGraph(data({ clusters: [{ id: "k1", label: "Fluids", members: ["a", "b"] }] }), new Set(["a", "b", "d"]), isImp);
		assert.deepEqual(g.topics.map((t) => t.id), ["a", "b", "d"]);
		assert.deepEqual(g.clusters.map((c) => c.label), ["Fluids", ""], "d lands in the ungrouped cluster");
		const hidden = buildViewGraph(data(), new Set(["a", "b", "c"]), isImp);
		assert.deepEqual(hidden.clusters.map((c) => c.label), ["Fluids"], "Structures has no visible topic");
	});

	it("cloud points are seeded: same input, same field; counts follow the budget", () => {
		const g = buildViewGraph(data(), null, isImp);
		const one = buildCloudPoints(g, "standard");
		const two = buildCloudPoints(g, "standard");
		assert.deepEqual(one[7], two[7]);
		assert.equal(one.filter((p) => p.cluster === 0).length, 40 + 12 * 3);
		assert.equal(one.filter((p) => p.cluster === 1).length, 40 + 12 * 2);
		assert.ok(buildCloudPoints(g, "lighter").length < one.length);
		for (const p of one) {
			assert.ok(p.size >= 1.1 && p.size <= 1.9);
			assert.ok(p.co >= 0.12 && p.co <= 0.8);
			assert.ok(p.delay >= 0 && p.delay <= 140);
			assert.equal(g.topics[p.topic]!.cluster, p.cluster, "a point swarms onto a topic of its own cluster");
		}
	});

	it("the density falloff: points near the centre rest brighter", () => {
		const g = buildViewGraph(data(), null, isImp);
		const pts = buildCloudPoints(g, "standard").filter((p) => p.cluster === 0);
		const inner = pts.filter((p) => Math.hypot(p.hx, p.hy) < 0.4);
		const outer = pts.filter((p) => Math.hypot(p.hx, p.hy) > 1.8);
		const mean = (xs: number[]) => xs.reduce((a, c) => a + c, 0) / xs.length;
		assert.ok(inner.length && outer.length);
		assert.ok(mean(inner.map((p) => p.co)) > mean(outer.map((p) => p.co)));
	});
});

describe("cloud hit test and drift", () => {
	it("finds the cluster under a world point, nearest centre first", () => {
		const g = buildViewGraph(data(), null, isImp);
		const geo = clusterGeometry(g);
		assert.equal(clusterAt(geo, geo[0]!.cx, geo[0]!.cy), 0);
		assert.equal(clusterAt(geo, geo[1]!.cx, geo[1]!.cy), 1);
		assert.equal(clusterAt(geo, 5000, 5000), null);
	});

	it("drift stays within ±8px x / ±6px y and loops on 16–28s periods", () => {
		const d = driftFor("topic-1");
		assert.ok(d.px >= 16 && d.px <= 28 && d.py >= 16 && d.py <= 28);
		for (let t = 0; t < 60_000; t += 700) {
			const o = driftOffset(d, t);
			assert.ok(Math.abs(o.x) <= 8 && Math.abs(o.y) <= 6);
		}
		const a = driftOffset(d, 1234);
		const b = driftOffset(d, 1234 + d.px * 1000);
		assert.ok(Math.abs(a.x - b.x) < 1e-6, "x repeats after its period");
	});
});

describe("the neural model and projection", () => {
	it("topics lead, neurons fill each subject within budget, synapses are the topic links", () => {
		const g = buildViewGraph(data(), null, isImp);
		const m = buildNeural(g, "standard");
		assert.equal(m.topicCount, 5);
		assert.equal(m.nodes.filter((n) => n.topic < 0).length, 6 + 2 * 3 + (6 + 2 * 2));
		assert.ok(m.nodes.slice(0, 5).every((n) => n.topic >= 0));
		assert.equal(m.synapses.length, g.links.length);
		assert.ok(m.nodes.every((n) => Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1 && Math.abs(n.z) <= 1), "inside the cube");
		for (const [a, b] of m.neuronLinks) assert.equal(m.nodes[a]!.cluster, m.nodes[b]!.cluster, "links stay within a subject");
		assert.ok(m.neuronLinks.length > 0);
		assert.deepEqual(buildNeural(g, "standard").nodes[9], m.nodes[9], "seeded");
	});

	it("a full revolution returns to the start, and the auto-turn is one per 80s", () => {
		const a = project(0.4, -0.2, 0.7, 0, START_PITCH, 100, 100, 220);
		const b = project(0.4, -0.2, 0.7, Math.PI * 2, START_PITCH, 100, 100, 220);
		assert.ok(Math.abs(a.sx - b.sx) < 1e-9 && Math.abs(a.sy - b.sy) < 1e-9);
		assert.ok(Math.abs(AUTO_TURN_RAD_PER_MS * 80_000 - Math.PI * 2) < 1e-12);
	});

	it("perspective: farther points are smaller", () => {
		const near = project(0, 0, -1, 0, 0, 0, 0, 100);
		const far = project(0, 0, 1, 0, 0, 0, 0, 100);
		assert.ok(near.s > far.s);
		assert.ok(far.z > near.z);
	});

	it("picks the topic under a screen point, and none far away", () => {
		const g = buildViewGraph(data(), null, isImp);
		const m = buildNeural(g, "standard");
		const proj = projectModel(m, 0.3, START_PITCH, 400, 300, 220);
		assert.equal(neuralTopicAt(m, proj, proj[2]!.sx, proj[2]!.sy), 2);
		assert.equal(neuralTopicAt(m, proj, -500, -500), null);
	});
});
