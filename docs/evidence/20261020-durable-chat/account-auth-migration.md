# Account-owned Codex authentication migration

The current resident refresh design copies the same rotating OAuth credential into independent Agent homes. Nfs2's native account/read returned refresh_token_reused401; the source account file retained its older revision. Refreshing each Agent independently is therefore not a valid multi-Agent ownership model.

## Implemented, not connected to live Agents

- managed-access-broker.ts accepts the existing selected account owner, coalesces same-account renewals and projects only accessToken/account scope/expiry. The refresh hook operates on the original account source. It requires an account lock and durable STARTED/COMPLETED rotation records; an unfinished rotation is not retried for the same source revision, including after broker replacement. No token bytes belong in PG records.
- external-codex-auth.ts uses account/login/start(chatgptAuthTokens), handles the native refresh callback within its bounded deadline, validates the selected account, and supplies access-only results. The existing initialization handshake already advertises experimentalApi.
- Broker concurrency/source-change/failed-renewal tests4PASS; external login/callback/foreign-account test1PASS. Source lint clean.
- Actual installed Codex0.160.1 accepted external login with the selected account's access token, and account/read(refreshToken:false) reported chatgpt/requiresOpenaiAuth=true. Source credential metadata remained unchanged; refresh requests0, native threads0, inputs0. The isolated auth process closed with exit proof. This verifies the installed authentication contract, not inference or Agent integration.

## Remaining implementation sequence

1. Implemented source-side composition: migration033 and the PG rotation store commit each revision claim before OAuth I/O, exclude concurrent account owners, and preserve old consumed revisions. The original selected account home is resolved through the existing credential owner; source refresh requires native close proof. Actual isolated PG test1PASS, broker5PASS, source/owner2PASS, lint clean. Migration033 is applied only in the owned test database, not live orca_dev. The runtime openSource and private Agent channel still need wiring. Unconfirmed source-process exit must be reconciled before enabling another rotation; fresh file revision alone is not physical exit proof.
2. Connect the broker to private Agent control bootstrap and bounded native refresh replies. Gate the new contract by a capability; remove refresh-token/auth.json replication from the new path. Keep token-bearing replies out of durable frame/output journals. Old control hosts must not silently fall back to the copied-refresh path.
3. Transition existing hosts through normal owned retirement/adoption rules, retain HOME/native identity, and reconcile the original UNKNOWN message without resending it. Recover the selected source credential with explicit provenance if its old refresh token is already spent; the successful access-only login does not prove future renewal.
4. Publish the new control artifact once, verify actual Agent authentication and inference, then resume the remaining task05 Terminal/Chat work. Current deployed revision remains3d72af60; modules in this change are not activated.

Official contract: https://learn.chatgpt.com/docs/app-server (authentication). The installed schema describes external tokens as unstable/internal; the actual installed authentication-only check above confirms protocol support. No provider/model route was replaced with the unrelated Sign-in-with-ChatGPT Responses API setup.
