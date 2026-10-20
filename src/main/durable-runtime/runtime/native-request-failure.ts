import {isCodexAppServerRequestError} from '../../codex/codex-app-server-request-error.ts'
/** Retain only bounded categories and the upstream numeric RPC code. Provider
 * messages may contain credentials or user input and never enter the journal. */
export function nativeRequestFailure(error:unknown):Readonly<{nativeCode:number|null;category:string}> {
  const message=error instanceof Error?error.message:''
  const raw=isCodexAppServerRequestError(error)?Reflect.get(error as object,'code'):null
  const nativeCode=typeof raw==='number'&&Number.isSafeInteger(raw)?raw:null
  const category=/thread.*(?:not found|does not exist)|no (?:rollout|thread).*found|failed to (?:find|load).*thread/i.test(message)?'THREAD_UNAVAILABLE'
    :/unauthorized|authentication|required.*auth|not logged in|401/i.test(message)?'AUTH_REJECTED'
    :/invalid param|invalid request/i.test(message)?'REQUEST_REJECTED'
    :/timeout|timed out/i.test(message)?'TIMEOUT'
    :isCodexAppServerRequestError(error)?'PROVIDER_REJECTED':'TRANSPORT_OR_LOCAL_FAILURE'
  return Object.freeze({nativeCode,category})
}
