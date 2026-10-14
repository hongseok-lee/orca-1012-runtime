import { CatalogError } from './errors.ts'
import { captureCatalogJson } from './immutable.ts'

declare const catalogAuthority: unique symbol

/** Supplied by the authenticated/authorized upper boundary. No proof factory. */
export type CatalogAuthority = {
  readonly [catalogAuthority]: true
  readonly principalId: string
  readonly repositoryIds: readonly string[]
  readonly projectGroupIds: readonly string[]
  readonly workspacePublicIds: readonly string[]
}

function ids(input: readonly string[]): readonly string[] {
  const copied = captureCatalogJson(input)
  if (!Array.isArray(copied) || copied.some(id => typeof id !== 'string' || !id)) {
    throw new CatalogError('CATALOG_AUTHORITY')
  }
  return copied as readonly string[]
}

/** Copies an existing authority; validating its shape is not authentication. */
export function captureCatalogAuthority(input: CatalogAuthority): CatalogAuthority {
  const principalId = input?.principalId
  if (typeof principalId !== 'string' || !principalId) {
    throw new CatalogError('CATALOG_AUTHORITY')
  }
  return Object.freeze({
    principalId,
    repositoryIds: ids(input.repositoryIds),
    projectGroupIds: ids(input.projectGroupIds),
    workspacePublicIds: ids(input.workspacePublicIds)
  }) as CatalogAuthority
}
