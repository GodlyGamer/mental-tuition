import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../components/composer.tsx";
import { QuestionDock } from "../components/question-dock.tsx";

const base = { busy: false, value: "", onChange: () => {}, onSend: () => {}, onStop: () => {}, canSend: false };

describe("the composer's + button", () => {
	it("shows when the page accepts photos, with a hidden multi-image picker", () => {
		const html = renderToStaticMarkup(<Composer {...base} onAddPhotos={() => {}} />);
		assert.match(html, /data-testid="composer-plus"/);
		// The slab tray's round glass paperclip (Hot Glass).
		assert.match(html, /aria-label="Attach files or photos"/);
		assert.match(html, /type="file" accept="image\/\*" multiple/);
	});

	it("is absent where photos aren't wired (the draft views)", () => {
		assert.doesNotMatch(renderToStaticMarkup(<Composer {...base} />), /composer-plus/);
	});

	it("previews attached photos with a remove control, and shows attach errors", () => {
		const html = renderToStaticMarkup(
			<Composer
				{...base}
				onAddPhotos={() => {}}
				photos={[{ id: "a", data: "x", mimeType: "image/jpeg", previewUrl: "data:image/jpeg;base64,x" }]}
				photoError="unsupported format"
			/>,
		);
		assert.match(html, /data-testid="composer-photos"/);
		assert.match(html, /src="data:image\/jpeg;base64,x"/);
		assert.match(html, /aria-label="Remove photo"/);
		assert.match(html, /unsupported format/);
	});
});

describe("the question dock's + button", () => {
	it("sits in the dock footer, small, next to Submit", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="quiz"
				toolCallId="t1"
				input={{ question: "Which?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "" } as never}
				expanded={true}
				phase="teach"
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /data-testid="composer-plus"/);
		assert.match(html, /class="[^"]*size-8[^"]*"[^>]*><svg/);
	});
});
