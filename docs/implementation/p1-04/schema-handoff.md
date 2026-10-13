# P1-04 attachment schema predecessor

Separate branch `implementation/p1-04-attachment-schema` stacks on P1-02 draft PR8 head `b124d1f7dc493ac537c5de4f83ae5b5c8da386aa`. Root attachment contract is implemented in new migration **008-attachment-store.sql**. Applied migrations001–007 and common identity API bytes remain unchanged. No package changes.

The fixed relations are `attachment_blobs`, `attachment_uploads`, `attachment_upload_chunks`, `attachment_aliases`. `input_attachments(blob_ref,content_hash)` references the alias/hash pair. `rows.ts` adds four projections; BIGINT remains decimal strings. Server-reserved upload UUID is a string projection; common identity.ts is unchanged.

Blob hash is lowercase SHA256 of decoded bytea (`encode(sha256(content_bytes),'hex')`); byte_length equals octet_length, including zero. Chunk hash is lowercase SHA256 of the exact original UTF-8 base64 text, char_length equals PostgreSQL length(content_base64), positive chunks only. Store handles the existing base64/parser rules, contiguous offset and no-op empty append. The DB preserves chunks and rejects update/delete; insert locks the upload and requires OPEN.

Uploads preserve id/principal/target/expected/creation time; counters cannot regress and terminal state/received length cannot change. COMMITTED requires received=expected. Blob, alias, chunks and original input attachment relations reject update/delete. Alias upload owner is enforced with composite FK, blob by FK; one alias per upload. Upload and alias deferred constraint triggers enforce COMMITTED iff one alias exists, allowing the three commit effects in either order within one transaction. Alias insertion locks the upload before validation, so direct SQL cannot bypass upload serialization.

Follow common Session→Runtime Unit→storage/operation ordering before upload locks; the store must compare authenticated owner before exposing/altering data. Database ownership relations do not authenticate the caller. The alias CHECK requires an absolute non-dot-segment path; root directory and reserved filename remain trusted server/materializer responsibilities and are not configured here.

This predecessor contains no store/materializer algorithm, RPC/UI/provider wiring, P1-03 business receipt or uncertain COMMIT work. Root/client consume the actual SHA; no acceptance of the full P1-04 feature is implied.
