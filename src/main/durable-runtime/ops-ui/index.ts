import { renderOpsUiShell } from './shell.ts'
import { opsUiStyles } from './styles.ts'
import { opsUiClientSource } from './client.ts'
import type { OpsUiProvider } from '../ops/contract.ts'

/** Pure static provider. The HTTP owner supplies no-store/security headers and routing. */
export const getOpsUiAsset: OpsUiProvider = (pathname) => {
  if (pathname === '/ops/' || pathname === '/ops') {
    return { contentType: 'text/html; charset=utf-8', body: renderOpsUiShell() }
  }
  if (pathname === '/ops/styles.css') {
    return { contentType: 'text/css; charset=utf-8', body: opsUiStyles }
  }
  if (pathname === '/ops/app.js') {
    return { contentType: 'text/javascript; charset=utf-8', body: opsUiClientSource }
  }
  return null
}
export { renderOpsUiShell } from './shell.ts'
