import { CatalogError } from '../catalog/errors.ts'
import { reserveAttachmentAlias } from '../attachments/store.ts'
import { attachmentUploadId } from '../attachments/types.ts'

export type CatalogClipboardConfig = { readonly aliasRoot: string }

function invalid(): never { throw new CatalogError('CATALOG_CLIPBOARD_CONFIGURATION') }

/** Optional server-owned data only. No request/environment fallback or filesystem access. */
export function captureCatalogClipboardConfig(
  descriptor: PropertyDescriptor | undefined
): CatalogClipboardConfig | undefined {
  if (descriptor === undefined) { return undefined }
  if (!('value' in descriptor)) { invalid() }
  const value: unknown = descriptor.value
  if (value === undefined) { return undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) { invalid() }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 1 || keys[0] !== 'aliasRoot') { invalid() }
  const alias = Object.getOwnPropertyDescriptor(value, 'aliasRoot')
  if (!alias || !('value' in alias)) { invalid() }
  const aliasRoot: unknown = alias.value
  if (typeof aliasRoot !== 'string' || !aliasRoot ||
      aliasRoot.includes('\0') || aliasRoot.includes('\r') || aliasRoot.includes('\n')) { invalid() }
  try {
    reserveAttachmentAlias(aliasRoot, attachmentUploadId('00000000-0000-4000-8000-000000000000'))
  } catch { invalid() }
  return Object.freeze({ aliasRoot })
}
