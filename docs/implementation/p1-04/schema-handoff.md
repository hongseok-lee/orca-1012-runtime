# P1-04 attachment schema predecessor

Separate branch `implementation/p1-04-attachment-schema` started on P1-02 PR8 head `b124d1f7dc493ac537c5de4f83ae5b5c8da386aa` and was rebased after root merged PR8 onto main `c19f6fbfc23d4109385f4de9b96f63083abe75d2`, preserving the verified product hashes. Root attachment contract is implemented in new migration **008-attachment-store.sql**. Applied migrations001–007 and common identity API bytes remain unchanged. No package changes.

The fixed relations are `attachment_blobs`, `attachment_uploads`, `attachment_upload_chunks`, `attachment_aliases`. `input_attachments(blob_ref,content_hash)` references the alias/hash pair. `rows.ts` adds four projections; BIGINT remains decimal strings. Server-reserved upload UUID is a string projection; common identity.ts is unchanged.

Blob hash is lowercase SHA256 of decoded bytea (`encode(sha256(content_bytes),'hex')`); byte_length equals octet_length, including zero. Chunk hash is lowercase SHA256 of the exact original UTF-8 base64 text, char_length equals PostgreSQL length(content_base64), positive chunks only. Store handles the existing base64/parser rules, contiguous offset and no-op empty append. The DB preserves chunks and rejects update/delete; insert locks the upload and requires OPEN.

Uploads preserve id/principal/target/expected/creation time; counters cannot regress and terminal state/received length cannot change. COMMITTED requires received=expected. Blob, alias, chunks and original input attachment relations reject update/delete. Alias upload owner is enforced with composite FK, blob by FK; one alias per upload. Upload and alias deferred constraint triggers enforce COMMITTED iff one alias exists, allowing the three commit effects in either order within one transaction. Alias insertion locks the upload before validation, so direct SQL cannot bypass upload serialization.

Follow common Session→Runtime Unit→storage/operation ordering before upload locks; the store must compare authenticated owner before exposing/altering data. Database ownership relations do not authenticate the caller. The alias CHECK requires an absolute non-dot-segment path; root directory and reserved filename remain trusted server/materializer responsibilities and are not configured here.

This predecessor contains no store/materializer algorithm, RPC/UI/provider wiring, P1-03 business receipt or uncertain COMMIT work. Root/client consume the actual SHA; no acceptance of the full P1-04 feature is implied.

## Actual focused verification

Five real-PG schema cases passed on the separately owned attachment validation DB: decoded blob hash/empty bytes/immutability; upload/chunk bounds/terminal/append-only constraints; alias owner/blob/deferred relation plus failed transaction rollback; exact accepted-input alias/hash FK; commit-versus-abort terminal serialization. Remote typecheck, repository-configured lint and format passed. Passed008 was then applied to the existing target schema. Both readbacks report eight migrations and48tables;001–007 checksums remain identical. See schema-verification.json and the two actual readbacks. These are DB schema checks, not the client store/materializer restart/access/provider acceptance tests. No P1-02 retest or new capture.
