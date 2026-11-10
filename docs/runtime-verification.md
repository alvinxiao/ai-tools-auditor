# Runtime verification

Checked on 2026-11-10 in the project workspace. No software was acquired during these checks.

- `codex --version` returned `codex-cli 0.167.0`.
- `codex login status` returned `Logged in using ChatGPT`. No credentials were printed or copied.
- `node --version` returned `v24.20.0`.
- Docker Server reported version `28.0.4`.
- Docker reported Linux, x86_64, 24 CPUs, and 33,180,618,752 bytes of memory.
- Windows reported 24 logical processors and 67,756,347,392 bytes of physical memory.

These checks establish command availability and reported login state. They do not prove a model request succeeds, subscription limits, unattended processing eligibility, or application isolation. No model request or API billing was initiated by these checks.

The workflow exports a research packet for a user-launched T3 session and imports the resulting assessment. It does not handle authentication or invoke an API. Isolated yt-dlp retrieval is now implemented and was exercised against three videos. Two usable transcripts were obtained; the third returned HTTP 429. See [the yt-dlp review](security/yt-dlp.md) for artifact verification, permissions, and remaining gaps.

The first-version acceptance gate still requires three user-selected video URLs and a chosen output destination. A standalone output folder is the default until a vault is selected. Synthetic fixtures cannot satisfy that gate.
