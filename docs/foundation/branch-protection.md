# Branch protection and review identity

The assigned policy permits GitHub-native required checks and PR restrictions,
while team lead review comments and the reviewed SHA record procedural acceptance.
One shared GitHub account cannot supply an independent self-approval.

The prepared main protection configuration requires the `Foundation checks` status,
up-to-date branches, pull requests, resolved review conversations, and linear history.
It enforces configured rules for administrators and disallows branch deletion and
force pushes. Approving-review count is zero, code-owner approval is not required,
and last-push independent approval is not required. CODEOWNERS routes review only.
No bypass identity is added. GitHub API readback is recorded in the foundation PR;
no independent approval enforcement or attempted write-denial test is claimed.

This configuration does not mechanically distinguish team lead and worker actions
when they share an account. Workers must not merge. The team lead records review
comments and the exact reviewed head SHA before deciding merge. A later commit needs
review of its new SHA. Draft or missing runtime/screenshot evidence remains incomplete.

Reference: [GitHub branch protection API](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection).
