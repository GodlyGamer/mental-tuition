import { isModuleCode } from "@/src/core";
import { moduleExists, moduleInfo, setModuleName } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * PUT /api/study/[code] { name } — set (or clear, with "" / null) the
 * module's display name, kept in study/modules/<CODE>/module.json. Shown in
 * the sidebar's MODULE grouping and edited on the Modules page.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ code: string }> }) {
	const { code } = await params;
	if (!isModuleCode(code) || !moduleExists(code)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
	if (!body || !("name" in body) || (body.name !== null && typeof body.name !== "string")) {
		return Response.json({ error: "name must be a string or null" }, { status: 400 });
	}
	if (typeof body.name === "string" && body.name.length > 80) {
		return Response.json({ error: "name must be 80 characters or fewer" }, { status: 400 });
	}
	setModuleName(code, body.name);
	return Response.json({ module: moduleInfo(code) });
}
