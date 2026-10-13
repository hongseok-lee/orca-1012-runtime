# P1-16 Catalog implementation status

This first commit provides the internal typed compatibility facade and immutable
first-await request capture. It imports the existing shared wire schemas, preserves
opaque launch tokens, strips pairing-local UI fields before retaining UI requests,
and prepares P1-03 receipt identities using a resolver-supplied canonical scope.
Legacy requests get a per-request key and do not gain network retry exactly-once
semantics. The query snapshot identity includes epoch, revision and query projection;
unsafe numeric revision overflow is rejected.

`CatalogCompatibilityFacade` is internal and is not registered in the public method
registry. SQL entries must be provided explicitly. An unavailable entry throws
`CATALOG_ENTRY_UNAVAILABLE`; it does not fabricate empty data, physical-stop results
or a tombstone-only successful close. An authority shape check is not authentication;
the upper authenticated boundary supplies `CatalogAuthority`.

The complete [root-assigned specification](task-spec.md) governs the remaining SQL
composition. Current dependency pins: database014 `9044549c071e0bb4d9c614d0f577ef39df417cb1`,
P113 intent snapshot `a99500d7424ff58843743eda173d8cc7156a0eee` and same-transaction sleep
`d668ca342709c6ee1874c4d5542b743ab3202be0`, P107 cancel
`ae861915091894e91b66dcb766956205f870c83b`. These predecessors are not assumed verified
or merged into the baseline main. Their common files remain owned by their authors.

New request-boundary test code is written but has not run. No typecheck, application
installation/build, PostgreSQL execution, remote reconnection, source sync/watch,
cloud/Pod operation or rendered screenshot was performed. Remote verification and
the first actual capture wait for the root's explicit environment recovery notice.
This partial source commit does not complete P1-16, activate RPCs or establish provider,
PTY, storage-fence or HA qualification.
