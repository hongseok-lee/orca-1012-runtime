# Assigned repository foundation specification

Status: foundation preparation only. This is the complete public rendering of the
team lead's assigned repository task, with private identifiers and paths omitted.
It does not introduce an implementation worklist or change task priorities.

Create the explicitly authorized public repository `hongseok-lee/orca-1012-runtime`.
Report and verify its URL and public visibility immediately. The initial main branch
contains only a secret-free README, MIT license, and upstream provenance bootstrap.
Do not push the existing private platform repository or its history to this repository.

Use an independent checkout. Import product source from the public
`stablyai/orca` commit `776e424e76405a06851dd9ec9ff3b58ffbdb3eea` through a foundation
branch and pull request. Preserve the MIT license and copyright notice and record
the upstream SHA. Exclude upstream deployment and publishing workflows. Separate,
lightweight CI may be introduced in the PR. Inspect public examples for credential
literals and report only the path and type of any finding, never its value.

Private operational backups, user conversations, agent history, frozen session
snapshots, authentication/configuration/state, real account credentials, environment
files, and the entire private platform repository are excluded. Existing private
platform patches require a specific list, targets, and publication review before
inclusion; do not publish the complete series automatically. Do not edit team lead
planning documents, agent instructions, or persistent memory. Preserve management
services, backups, frozen source sessions, and history stores.

Apply the team lead's PR/development policy and common contracts. Public copies
retain their product requirements and task meaning while omitting private operation
identifiers, backup locations, and unrelated environment details. The October 12
revised design remains the implementation authority; October 11 handoff documents
are references. Explicitly unresolved requirements, including the additional cold
resume continuation policy, remain unresolved until a later user decision. Do not
redesign the product or create a new feature task list.

Each PR includes the full public task specification, not just a link, actual changes,
actual capture evidence, source/backend/Expo revisions, and the exact test scope.
Prepare `.github/PULL_REQUEST_TEMPLATE.md`, minimal CODEOWNERS, feasible branch
protection options, and lightweight checks that do not build images or desktop
releases on every change. The same GitHub account cannot approve its own PR. The
team lead records review comments, reviewed SHA, acceptance, and merge; do not claim
independent approval enforcement. Workers address review comments but never merge.

Actual visual validation is not available at this stage. Do not create a fabricated
capture or claim visual completion. Open a draft PR and explicitly record unverified
screenshots, development runtime, and application tests. Development/visual evidence
must be completed before the team lead accepts the foundation. Foundation repository
checks are not product feature tests.

Perform only repository foundation work. P1/P2 feature implementation remains
prohibited pending the user's final start instruction and the team lead's decision.
Do not run image, release, or desktop builds. Record the repository URL/visibility,
branch/PR URL, actual changes/check results, and remaining prerequisites in the
private completion report. No external email or Slack communication is authorized.

PostgreSQL is a cluster-internal Pod backed by its dedicated persistent block PV.
PGDATA/WAL remain separate from the ordinary Agent NFS filesystem. NFS is a
cluster-internal server Pod exporting an SSD PV; Agent Pod home directories reside
on that NFS. Cloud SQL and Filestore are not prerequisites for this foundation.
Cloud provisioning waits for the team lead to specify the target/configuration.
The intended Orca Serve topology is Spot 1 Active + 1 Standby; foundation work
must not declare P1-14 HA implementation or qualification complete.

Development uses remote backend source/API updates with minimal incremental
transformation and an Expo development environment. Expo/browser startup is deferred
to the designated remote development environment. Existing management endpoints are
not reused, restarted, or reconfigured for product tests. Expo Web click/screenshots,
native iPhone, and Mac evidence remain distinct. No runtime/environment changes are
part of this repository task.

Frozen orchestration source sessions remain read-only and excluded from the public
repository. They may be referenced only as immutable fork sources; their instructions,
configuration, history, and execution state must not be changed. The worker operates
in its separate task session and does not spawn other workers for this task.
