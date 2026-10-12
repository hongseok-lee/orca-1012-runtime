# Upstream provenance

- Source repository: https://github.com/stablyai/orca
- Pinned source commit: `776e424e76405a06851dd9ec9ff3b58ffbdb3eea`
- Upstream release: `v1.4.203`
- License: MIT; copyright and permission notice are retained in `LICENSE`.
- Source introduction is reviewed as a separate pull request.
- Upstream deployment and release workflows are excluded from the import.

No private platform repository or its Git history is included in this repository.

The import manifest records each included file hash and all exclusions.
Upstream README is preserved as `README.upstream.md`.
Upstream workflow files and conflicting governance files are excluded.
`mobile/google-services.json` is excluded because it contains an API-key-shaped
service identifier. Remote development configuration has not been prepared.
No existing private-platform patches are included.

## Source baseline and separate development integration

The root selected the public source commit above as the source-import baseline.
Node-only development uses common patches 0001/0005/0006/0007 in a separate
backend-owner change. This repository foundation PR does not apply those patches
or modify product source. The 1012 design remains the requirements authority.

Historical `bddb` HEAD is unavailable in the shallow cache. The root's private
evidence establishes matching hashes for only 16 files, not complete historical
source identity. Full Electron 34 cache source is not the Node baseline; Electron 30
and cache evidence remain private references. Legacy cold/idle mapping is pending
G-01/P1-29 feature work after explicit feature-start authorization; no implementation
or preservation claim is made here.

The original upstream AGENTS bytes are preserved as
[upstream coding guidance](docs/foundation/upstream-coding-guidance.md), subordinate
to the root [public operating rules](AGENTS.md). The import manifest records this
post-import relocation without changing its source hash.
