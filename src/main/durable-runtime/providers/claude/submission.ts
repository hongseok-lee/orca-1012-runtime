import { createHash } from 'node:crypto'
import { claudeDispatchMessageContent } from '../../../claude/claude-structured-dispatch-content.ts'
import type { NativeChatBlock } from '../../../../shared/native-chat-types.ts'
import type { ProviderDispatchRequest } from '../shared/contracts.ts'
import { ProviderInputError, renderRecoverySubmission } from '../shared/recovery-renderer.ts'

export async function claudeSubmissionContent(request: ProviderDispatchRequest): Promise<unknown[]> {
  const rendered = renderRecoverySubmission(request.context, request.sealed)
  if (request.attachments.length !== rendered.attachmentOrder.length) {
    throw new ProviderInputError('ATTACHMENT_IDENTITY_MISMATCH')
  }
  const blocks: NativeChatBlock[] = []
  for (const [index, expected] of rendered.attachmentOrder.entries()) {
    const actual = request.attachments[index]
    if (!actual || actual.inputId !== expected.inputId || actual.position !== expected.position ||
        actual.aliasPath !== expected.aliasPath || actual.contentHash !== expected.contentHash) {
      throw new ProviderInputError('ATTACHMENT_IDENTITY_MISMATCH')
    }
    blocks.push({ type: 'image-ref', path: actual.path })
  }
  blocks.push({ type: 'text', text: rendered.text })
  const content = await claudeDispatchMessageContent({ kind: 'message', role: 'user', blocks })
  for (const [index, expected] of rendered.attachmentOrder.entries()) {
    const block = content[index]
    if (!block || typeof block !== 'object' || !('source' in block)) {
      throw new ProviderInputError('ATTACHMENT_WIRE_MISMATCH')
    }
    const source = block.source
    if (!source || typeof source !== 'object' || !('type' in source) || source.type !== 'base64' ||
        !('data' in source) || typeof source.data !== 'string' ||
        createHash('sha256').update(Buffer.from(source.data, 'base64')).digest('hex') !== expected.contentHash) {
      throw new ProviderInputError('ATTACHMENT_WIRE_MISMATCH')
    }
  }
  return content
}
