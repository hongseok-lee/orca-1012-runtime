# Orca 1012 Runtime

Reviewed runtime development based on the public
[stablyai/orca](https://github.com/stablyai/orca) source pinned at
`776e424e76405a06851dd9ec9ff3b58ffbdb3eea` (`v1.4.203`).

This is a foundation source import and review-tooling preparation. Planned product
features, remote backend/Expo startup, storage recovery, and HA are unimplemented or
unverified in this work. Feature execution waits for the user's explicit start instruction.

- [Preserved upstream README](README.upstream.md)
- [MIT license](LICENSE) and [upstream provenance](UPSTREAM.md)
- [Full assigned foundation specification](docs/foundation/repository-task.md)
- [PR and remote development policy](docs/foundation/pr-development-workflow.md)
- [Executed check scope and remaining evidence](docs/foundation/verification.md)

Changes go through pull requests. The team lead reviews the current SHA and decides
merge; workers never merge. Missing actual screenshots or execution evidence keep the
foundation PR draft. Lightweight CI does not run desktop, image, or release builds.
