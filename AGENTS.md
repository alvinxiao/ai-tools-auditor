# External software checks

Before downloading third-party executables, scripts, packages, or container images, check the official upstream source, current security advisories, and the intended version's known risks. Record the evidence and intended permissions before acquisition.

After download and before execution, verify the artifact against the upstream published digest or signature where available. Report verification gaps explicitly; a matching digest establishes artifact identity, not absence of malicious code. Inspect install hooks and automatic plugin or remote-code loading where applicable.

Run tools with only the access needed for the task. For transcript retrieval, use an isolated output directory, disable automatic configuration and plugins, avoid account cookies and shell execution hooks, and keep the vault, credentials, and container engine socket inaccessible to the retrieval process. Prefer a non-root container with narrowly scoped mounts for the eventual application.

The initial yt-dlp review is recorded in [docs/security/yt-dlp.md](docs/security/yt-dlp.md). Recheck advisories and verify the exact artifact when changing versions.
