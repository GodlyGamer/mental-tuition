<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/mt_mark_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/mt_mark_light.svg">
    <img src="docs/assets/mt_mark_light.svg" alt="Mental Tuition dragon mark" width="96">
  </picture>
</p>

<h1 align="center">Mental Tuition</h1>

<p align="center"><strong>An agent harness for learning.</strong></p>

<p align="center">
  <a href="https://github.com/GodlyGamer/mental-tuition/releases">Download</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/development.md">Documentation</a> ·
  <a href="https://github.com/GodlyGamer/mental-tuition/issues">Issues</a>
</p>

<p align="center">Built on <a href="https://github.com/amosblomqvist/learnharness">LearnHarness</a> by Amos Blomqvist.</p>

Mental Tuition uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason. That picture is updated as you learn.

Instead of just giving you an explanation, it uses your answers and thinking to decide what you need next. Teaching builds understanding one reasoning step at a time. Practice makes it usable. A persistent knowledge graph carries it across sessions.

![Mental Tuition teaching session](docs/assets/teaching-session.png)

## How it works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on. Your answers, confidence, and thinking show it where to start.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see the plan, and the lesson adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them. The aim is for the goal to feel obviously true, not merely familiar.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first. Problems and hints adapt to your reasoning.

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. This is how the agent gets a detailed picture rather than just a record of right and wrong answers. You can type or use dictation.

The agent can also research questions in the background, create visual explanations, and build interactive demonstrations.

## Knowledge that carries forward

What you are taught accumulates as propositions and reasoning chains: individual claims and the premises that lead to them. The graph shows this structure, with links back to the source sessions. You can also import notes.

Future teaching sessions can read the graph instead of starting from scratch. Practice sessions can draw their material from it. It stores the ideas and their connections, not ratings of your ability.

![Mental Tuition knowledge graph](docs/assets/knowledge-graph.png)

## Download and get started

**[Download from GitHub Releases](https://github.com/GodlyGamer/mental-tuition/releases)**

- **macOS (Apple Silicon):** signed and notarized DMG. Drag the app to Applications.
- **Windows (x64):** run the installer. It is currently unsigned; Windows may show an “unknown publisher” or SmartScreen warning.
- **Linux (x64):** make the AppImage executable and open it, or install the Debian/Ubuntu `.deb`.

Add your provider API key and choose your models, then start a session with what you want to understand. Mental Tuition supports 30+ provider options, including OpenAI, Anthropic, Google, DeepSeek, and OpenRouter. Optional dictation and web search use separate service keys.

All three platforms support in-app updates.

## Your keys, your data

- **Your keys and models.** No Mental Tuition subscription or markup. You pay your providers for usage; a live cost meter shows model costs.
- **Local storage.** Your chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. Local storage does not mean offline processing.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## This personal build

This fork runs without API keys:

- **Models:** every agent runs on your Claude subscription through the Claude Agent SDK (the local Claude Code login). Opus 5.5 teaches; Sonnet 5.5 runs research, visuals and extraction. You can change either in Settings → Models. Use it for personal, local learning only: Anthropic's terms don't allow building a product on a subscription login.
- **Gemini (optional):** Gemini runs on your Google sign-in through Google's own Antigravity ACP server (kept in the git-ignored `.tools/` folder). `npm.cmd run setup:gemini` downloads it (about 130MB) from the URL listed in the official ACP registry. It installs nothing unless the file's SHA-256 matches the registry's, and on Windows both programs must be signed by Google LLC. Then sign in once with `npm.cmd run login:gemini`; "Gemini … (Google login)" models then appear in the model picker. Your Google plan decides which models you get.
- **Dictation:** Whisper runs on your computer. The ~80MB model downloads the first time you dictate; after that it works offline.
- **Look:** the Mentaljineer liquid-glass design, with Dark, Light and Nocturne themes in Settings → Appearance.

First run:

```bash
npm install
npm run login        # sign in to Claude once (opens the browser)
npm run setup:gemini # optional: install Google's Antigravity server for Gemini
npm run login:gemini # optional: then sign in to Gemini with Google
npm run desktop:dev  # the desktop app; or `npm run dev` for http://localhost:3000
```

Check the login at any time with `npm run login -- status`.

### The Windows app

`npm.cmd run desktop:dist:win` builds `dist/MentalTuition-<version>-x64-setup.exe` (the personal build is called Mental Tuition; its settings live in `%APPDATA%\Mental Tuition`, copied once from the older `MentalTuition` or `LearnHarness` folder). The installer isn't signed, so the first time Windows says "Windows protected your PC": choose **More info → Run anyway**. Releases are on [this fork's Releases page](https://github.com/GodlyGamer/mental-tuition/releases), and the app updates itself from there.

- **Your folder:** on first launch the app asks where to keep your work. Pick a folder in Google Drive (for example `My Drive\Mental Tuition`) and your PC and laptop share chats, the knowledge graph, settings and study modules. The app warns you if the folder is already open on your other computer, because Drive can't merge two computers writing at once.
- **Set up this computer:** the next screen signs you in to Claude, can install Gemini and sign you in with Google, and can install the paper tools (Python with sympy, numpy and PyMuPDF; MiKTeX; Strawberry Perl) through winget and pip. These stay per machine; they're in Settings → This computer afterwards.

## Development and support

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # deterministic, no LLM, no network
```

See the [development guide](docs/development.md), [architecture](docs/architecture.md), and [desktop release guide](docs/desktop-release.md).

Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/GodlyGamer/mental-tuition/issues).

## License and credit

[AGPL-3.0](LICENSE).

Mental Tuition is built on [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist.

- © 2026 Amos Blomqvist: LearnHarness
- © 2026 Youssouf Diallo: Mental Tuition's changes

Both are released under the AGPL-3.0.

The app is free and open forever. If we ever charge for anything, it will be for convenience — managed keys, hosting — never for features you can run locally.
