# PR and development workflow

Public rendering of the team lead's development policy, dated 2026-10-12.
Foundation preparation is in progress; P1/P2 implementation has not started.
Existing task IDs, final acceptance criteria, and dependencies are preserved.
The team lead requests the user's final feature start instruction after foundation
preparation and review are complete.

## Roles and publication

The team lead owns planning, task interpretation, file ownership, dependencies,
acceptance criteria, review comments, correction instructions, and merge decisions.
Execution workers implement specifically assigned changes and collect actual evidence
in separate branches/worktrees. They do not create feature plans or merge PRs.
Frozen context sources remain immutable; current instructions apply only to workers.

The public repository uses a verified pinned public upstream source and preserved
license notices. After minimal main bootstrap, source, tooling, infrastructure, and
document changes go through PRs. Publish only assigned product source, reviewed patches,
public task specifications, and sanitized reproduction evidence. Exclude private
repository history, backups, user homes/conversations, authentication, pairing keys,
credentials, environment files, and agent history/configuration. Capture new test data
without authentication values. Upstream release/deployment automation is not activated.

## Required PR content

1. Concrete problem/trigger and resulting behavior, existing IDs, and scope.
2. Full public task specification, its path/revision, covered portion, and remainder.
   A link alone is insufficient; multiple IDs need their respective full specifications.
3. Actual changed boundaries, shared contracts/revisions, prerequisite PRs, and
   application/rollback steps when state or deployment is affected.
4. Actual interaction steps, expected/observed results, device/viewport/browser/time,
   and accessible screenshots. Include before/after evidence where comparison matters.
5. PR source SHA, backend and Expo revisions, secret-free endpoint identifiers,
   actual API/check results, and unverified limitations.
6. Development reload/incremental transformation used, or a specific reason for a
   full build. Do not automatically build images or desktop packages on each change.

Backend changes also need related screen and API/state evidence. Documentation and
foundation PRs may show actual rendered documentation or development screens; those
captures are not product functionality tests. Generated images, fixtures, and static
mockups are not actual screenshots. Missing captures or unavailable validation keep
the PR draft/incomplete with a reason. Screenshots alone do not qualify durability,
idempotency, writer fencing, or HA.

## Review and merge

The team lead compares the actual diff, current head SHA, specification, and evidence,
then leaves concrete review comments and gives workers bounded corrections. Workers
update the same PR with fixes and follow-up evidence. The team lead reviews the new
head SHA before accepting/merging. A prior review does not cover later commits.
After merge, the environment owner updates the shared development revision and checks
the affected scope. Workers resolve conflicts and code changes under review.

With one GitHub account, author self-approval is unavailable. CODEOWNERS routes review
but does not create an independent approval identity. The team lead's comment and
reviewed SHA record procedural acceptance. Available required checks and PR/direct-push
restrictions are recorded separately from procedural review. No worker merge is allowed.

## Remote development and evidence

Use remote backend source updates/watch/reload and Expo. Initial required dependencies
and incremental TypeScript/Metro transformations are allowed in the assigned environment.
Do not repeatedly reinstall unchanged dependencies or perform full production builds.
Dependency/native module/runtime/artifact changes need an explicit build-scope decision.
Image overlays are not hot reload. Remote startup/reload commands are documented only
after real execution. Management services are not used as product test runtimes.

The environment owner pins shared backend and Expo revisions. Evidence from different
concurrent revisions cannot be attributed to the same PR. Worker process/port/DB/session
isolation is bounded by actual resources. Required checks use relevant lightweight
lint/type/contract checks; blanket image/desktop builds are excluded.

## Storage and topology

PostgreSQL runs inside the cluster with a dedicated persistent block PV for PGDATA/WAL.
NFS is a cluster-internal server with an SSD PV; Agent homes are on its export.
PGDATA/WAL do not reside on Agent NFS. Cloud SQL/Filestore are not added as prerequisites.
Actual cluster/region/storage/admission values await the authorized environment owner.
Single PG/NFS recovery and Orca Serve Spot Active/Standby are separate qualification scopes.
Do not claim HA before actual takeover/fencing tests.

## Visual validation and foundation completion

Use the actual React Native `mobile/` source, connected to the backend, for iPhone-sized
Expo interactions. Record clicks, input, waits, actual results, screenshots, and backend
observations at the same revision. Viewing a screen or receiving HTTP 200 is insufficient.
Expo Web, native iPhone, and Mac are distinct; unavailable native capability evidence
remains missing. Development settings do not authorize new client features or public RPCs.

Before requesting feature start, the team lead verifies public source/visibility/license,
reviewed foundation PRs and protection settings, a remote backend API/reload path,
cluster PG/NFS storage state, actual Expo/backend interactions and screenshots, and worker
revision/review ownership. This repository PR covers source and review tooling only;
remote runtime, visual evidence, storage recovery, and product gates remain unverified.
