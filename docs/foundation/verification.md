# Foundation verification scope

Only repository foundation checks run in this PR. They do not install application
dependencies, start a server, build an image/desktop release, or run provider tests.

- Public upstream source revision: `776e424e76405a06851dd9ec9ff3b58ffbdb3eea`.
- Imported file hashes and exclusions: `provenance/upstream-import.json`.
- Executed backend revision: not started or deployed.
- Executed Expo revision: not started or served.
- Expo Web/native iPhone/Mac screenshots: unavailable; PR stays draft.
- Existing private-platform patches: none included. Any future selection needs review.

The public archive was inspected for known credential-literal shapes, including its
five example text files. No known matches were found in those example files. The
inspection is a bounded static scan, not a guarantee against all secret formats.

`mobile/google-services.json` contains a Google API-key-shaped service identifier and
is excluded. Values were not printed. Remote mobile configuration is still required.
Public redaction/security tests contain synthetic token shapes and fixture key material;
`browser-local-https-test-certificate.ts` explicitly defines a test-only localhost identity.
`ssh-security-key-identity.ts` contains key-format header strings, while its fixtures
construct test key data. These upstream test/parser files retain their original bytes;
they are not credentials supplied by this project. Full dependency/license/security
qualification has not been performed.

Run the dependency-free repository check with:

```sh
python3 tooling/check_repository_foundation.py
python3 -m unittest discover -s tooling -p 'test_repository_foundation.py'
```

For this initial source import only, also validate every imported file's recorded hash:

```sh
python3 tooling/check_repository_foundation.py --verify-import
```

The manifest is a baseline attestation. Later authorized product changes are not required
to remain byte-identical to upstream, so full hash comparison is an explicit import check,
not the mandatory check for every feature PR. Product lint/type/contract checks are added
for the assigned changed scope by subsequent reviewed work.

Publication-boundary fixtures verify rejection of tracked environment files,
unreviewed workflows, changed license notices, and new credential-shaped literals.
These are synthetic governance tests, not application or provider tests.
