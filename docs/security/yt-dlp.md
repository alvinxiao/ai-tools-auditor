# yt-dlp security review

Reviewed 2026-11-10. Version examined: official Windows executable 2026.10.26.

## Assessment

No evidence of malicious behavior was identified in this limited provenance, advisory, and targeted source review. This is not a full code audit, dependency audit, behavioral trace, or proof that the executable is harmless. The executable was originally downloaded and run before these checks; that ordering was a mistake.

yt-dlp is a candidate for narrowly scoped caption retrieval, subject to the execution restrictions below. A temporary directory alone does not isolate a process from the rest of the host.

## Artifact verification

- Download came from the official `yt-dlp/yt-dlp` GitHub release endpoint.
- The executable reports version `2026.10.26`.
- Its SHA-256 is `f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d`.
- That digest matches both the release asset metadata and the published `SHA2-256SUMS` entry.
- The executable has no Windows Authenticode signature. Upstream publishes GPG-signed checksums; GPG signature verification was not performed because GPG was unavailable on PATH. Both checksum sources are on the same upstream GitHub account and are not independent attestations.
- Windows Defender reported antivirus and real-time protection enabled and completed a custom scan. No detection matching the temporary test folder was returned afterward. This does not establish the absence of malware.

Sources: [release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26), [checksums](https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/SHA2-256SUMS), [verification instructions](https://github.com/yt-dlp/yt-dlp/tree/2026.10.26#release-files).

## Known concerns

The [published project advisories](https://github.com/yt-dlp/yt-dlp/security/advisories) include command execution through shell hooks, dangerous generated files, credential leakage, and external downloader behavior. Version 2026.10.26 is later than the listed yt-dlp patch versions reviewed, including June and July 2026 fixes. This does not cover undisclosed issues or establish that all bundled dependencies are vulnerability-free.

One historical advisory explicitly concerns a dependency on potentially malicious third-party code in the Douyu extractor, affecting versions 2023.09.24 through 2024.07.02 and fixed in 2024.07.07: [GHSA-3v33-3wmw-3785](https://github.com/yt-dlp/yt-dlp/security/advisories/GHSA-3v33-3wmw-3785). It does not describe the version or YouTube extractor used in our test.

The release notes state that bundled Brotli and certificate-related dependency vulnerabilities were addressed in 2026.10.26. That statement was reviewed, not independently reproduced.

YouTube extraction runs JavaScript challenges. The [version-pinned Node runner](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/extractor/youtube/jsc/_builtin/node.py) passes Node's permission flag. This reduces access for that subprocess; it does not isolate the main executable or substitute for a container boundary.

Plugins and configuration can introduce additional behavior. The first test invocation did not disable configuration loading; subsequent invocations used `--ignore-config`. None of the test commands explicitly supplied account cookies, shell execution hooks, remote components, or browser credentials. Plugins were not explicitly disabled during the original test, so this review cannot assert that no installed plugin was loaded.

## Future retrieval requirements

- Pin a reviewed version and verify its artifact before execution; recheck on upgrades.
- Pass `--ignore-config --no-plugin-dirs --no-remote-components` explicitly.
- Use caption-only retrieval with a fixed output directory and validated YouTube video IDs. Pass arguments directly rather than interpolating remote metadata into shell commands.
- Avoid cookies, browser profiles, login credentials, execution hooks, generated shortcuts, and external downloaders.
- Run as a non-root process in a container with only the scratch output directory writable. Keep the vault, host home, credentials, and Docker socket unmounted. Use a read-only root filesystem where compatible.
- Apply timeouts, resource and output limits, and rate-limit backoff. Containerization does not prevent network exfiltration of any data made accessible to the process.
- Treat transcript contents as untrusted source material, never executable commands or instructions to the auditor.

These are requirements for the future application, not claims about isolation achieved by the original host-side test.

## Isolated integration review, 2026-11-10

Before acquisition, the official release API for `2026.10.26`, release notes, version-pinned entrypoint source, and the project's public security-advisory API were rechecked. The API returned 13 published advisories. The newest published advisory was July 4, 2026. The reviewed release is later than their listed patch versions. This comparison does not audit dependencies or undisclosed vulnerabilities. Release notes report bundled Brotli and certificate fixes.

The intended artifact is the official Unix Python zipapp named `yt-dlp`, not the previously reviewed Windows executable. Its upstream release metadata gives SHA-256 `e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3`. Acquisition will use the official release URL and compare the file with both that digest and the published `SHA2-256SUMS` entry before execution. This artifact needs existing Python 3.11 or later. No package installer or install hooks are involved. Its CLI can load plugins and configuration, so those paths and remote components must be explicitly disabled.

Intended permissions: use the already present Linux container image, pinned to its local image ID for execution, as UID/GID 1000, with a read-only root filesystem, all capabilities dropped, and no new privileges. Mount only the verified artifact read-only and a fresh scratch output directory writable. Supply no account cookies, host home, credentials, vault, or Docker socket. Allow network access for public YouTube extraction. Bound runtime, CPU, memory, PIDs, retries, and retained output. Do not fetch a new image, install packages, update yt-dlp, or enable remote components automatically.

Sources: [official release API](https://api.github.com/repos/yt-dlp/yt-dlp/releases/tags/2026.10.26), [official advisory API](https://api.github.com/repos/yt-dlp/yt-dlp/security-advisories), [entrypoint source](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/__init__.py), and the release and checksum links above.

The downloaded Unix artifact matched the release metadata digest and the published checksum entry before execution. Its isolated `--version` invocation returned `2026.10.26`. No package install hooks were run. GPG signature verification was not performed. A matching digest establishes artifact identity, not absence of malicious code.

The first caption request reached YouTube successfully, solved its JavaScript challenge through the existing Node runtime, and then returned HTTP 429 on the selected English track. An [upstream maintainer's explanation](https://github.com/yt-dlp/yt-dlp/issues/13831#issuecomment-3712613129) identifies this behavior for auto-translated captions. The [version-pinned README](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/README.md) documents `youtube:skip=translated_subs`. With that extractor setting and `--sub-langs en-orig,en`, both original and English tracks downloaded for the first trial video. No cookies, account credentials, impersonation libraries, or remote components were added. This result does not guarantee availability for other videos.

The application now implements `retrieve ID`. Before each attempt it checks the pinned zipapp digest, resolves a configured existing image to its immutable local ID, and refuses automatic image pulls. It uses an ephemeral output directory, bounded processes and files, and a forced cleanup path after timeout. Caption text enters the catalog only after parsing a complete JSON3 file. HTTP 429 records a blocked item and a 15-minute retry cooldown.

The live three-video trial retrieved usable transcripts for two videos. The third returned HTTP 429 and remains blocked. A repeated application retrieval of the first video also received HTTP 429; the previously successful isolated run's original caption file was parsed and attached through `transcript`. These results validate retrieval paths, not complete researched audits or monitoring acceptance. Trial IDs, captions, and packets remain in ignored local state rather than public documentation. No retrieval containers remained running after these checks.
