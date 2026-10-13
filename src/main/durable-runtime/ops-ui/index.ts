import { renderOpsUiShell } from './shell.ts'
import { opsUiStyles } from './styles.ts'

export type OpsUiAsset = Readonly<{ contentType: string; body: string }>

/** Pure static provider. The HTTP owner supplies no-store/security headers and routing. */
export function getOpsUiAsset(pathname: string): OpsUiAsset | null {
  if (pathname === '/ops/' || pathname === '/ops') {
    return { contentType: 'text/html; charset=utf-8', body: renderOpsUiShell() }
  }
  if (pathname === '/ops/styles.css') {
    return { contentType: 'text/css; charset=utf-8', body: opsUiStyles }
  }
  return null
}
export { renderOpsUiShell } from './shell.ts'
