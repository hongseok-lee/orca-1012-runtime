import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { WebViewMessageEvent, WebViewProps } from 'react-native-webview'

export type TerminalWebSurfaceHandle = {
  postMessage: (message: string) => void
  reload: () => void
}

// Use the same bundled xterm document and command/notification protocol as native.
// The opaque-origin frame cannot read the paired host credentials in parent storage.
const BRIDGE = `<script>
window.ReactNativeWebView = { postMessage: function(data) {
  parent.postMessage({ orcaTerminal: true, data: data }, '*');
} };
window.addEventListener('message', function(event) {
  if (event.source !== parent) event.stopImmediatePropagation();
});
</script>`

export const WebView = forwardRef<TerminalWebSurfaceHandle, WebViewProps>(function WebView(
  props,
  ref
) {
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef(props)
  latest.current = props
  const [generation, setGeneration] = useState(0)
  const html = props.source && 'html' in props.source ? props.source.html : ''
  const document = useMemo(() => html.replace('<head>', `<head>${BRIDGE}`), [html])

  useImperativeHandle(ref, () => ({
    postMessage(message) {
      frame.current?.contentWindow?.postMessage(message, '*')
    },
    reload() {
      setGeneration((value) => value + 1)
    }
  }), [])

  useLayoutEffect(() => {
    // This surface's caller only uses the load-start notification, not native fields.
    latest.current.onLoadStart?.({ nativeEvent: {} } as Parameters<NonNullable<WebViewProps['onLoadStart']>>[0])
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.orcaTerminal !== true ||
        typeof event.data.data !== 'string'
      ) {
        return
      }
      latest.current.onMessage?.({ nativeEvent: { data: event.data.data } } as WebViewMessageEvent)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [document, generation])

  return (
    <iframe
      key={generation}
      ref={frame}
      title="Agent terminal"
      sandbox="allow-scripts"
      srcDoc={document}
      style={{ border: 0, width: '100%', height: '100%', flex: 1, minHeight: 0 }}
    />
  )
})
