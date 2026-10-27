"use client";
/**
 * The first-launch screen (personal fork, 2026-10-24): MachineSetup with a
 * Done button, full window. Done records setup for this computer and goes
 * home; the same steps stay in Settings → This computer.
 */

import { useRouter } from "next/navigation";
import { MtMark } from "@/components/mt-mark";
import { MachineSetup } from "./machine-setup.tsx";

export function SetupScreen() {
	const router = useRouter();
	return (
		<div className="relative flex h-dvh flex-col overflow-hidden">
			<div className="mt-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-2xl flex-col gap-5 px-5 pb-10 pt-16">
					<div className="flex items-center gap-3">
						<MtMark className="size-9" />
						<h1 className="font-title text-3xl">Set up this computer</h1>
					</div>
					<p className="text-sm text-muted-foreground">
						A few one-time steps for this machine. Your work itself comes from your folder, so a second computer picks up where you left off.
					</p>
					<MachineSetup onFinish={() => router.replace("/")} />
				</div>
			</main>
		</div>
	);
}
