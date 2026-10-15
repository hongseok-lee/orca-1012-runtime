import { Buffer } from 'buffer'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
import type { RpcClient } from '../transport/rpc-client'
import { MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS } from './browser-screencast-request'
import { MobileBrowserPane, type MobileBrowserTab } from './MobileBrowserPane'
import { MobileBrowserFrameLayer } from './MobileBrowserFrameSurface'

const platform = vi.hoisted(() => ({ os: 'web' }))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Image: 'Image',
  PanResponder: { create: () => ({ panHandlers: {} }) },
  PixelRatio: { get: () => 2 },
  Platform: { get OS() { return platform.os } },
  Pressable: 'Pressable',
  StyleSheet: {
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    create: (styles: unknown) => styles
  },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp', ChevronLeft: 'ChevronLeft', ChevronRight: 'ChevronRight',
  Monitor: 'Monitor', RefreshCw: 'RefreshCw', Smartphone: 'Smartphone'
}))

type Subscription = {
  listener: (payload: unknown) => void
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  unsubscribe: ReturnType<typeof vi.fn>
}
const mounted: ReactTestRenderer[] = []
let sequence = 0
afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount()
    }
  })
  vi.useRealTimers()
  platform.os = 'web'
})

function frame(text: string): BrowserScreencastFrame {
  return { opcode: BrowserScreencastOpcode.Frame, seq: ++sequence, format: 'jpeg',
    metadata: { deviceWidth: 360, deviceHeight: 640, pageScaleFactor: 1 },
    image: new TextEncoder().encode(text) }
}
const uri = (text: string) => `data:image/jpeg;base64,${Buffer.from(text).toString('base64')}`
function opacity(style: unknown): number | undefined {
  if (Array.isArray(style)) {
    return style.reduce<number | undefined>((value, entry) => opacity(entry) ?? value, undefined)
  }
  return style && typeof style === 'object' && 'opacity' in style
    ? (style as { opacity: number }).opacity : undefined
}
function sources(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType('Image').map(image => {
    const source = image.props.source
    return Array.isArray(source) ? source[0].uri : source.uri
  })
}
function visible(renderer: ReactTestRenderer): (number | undefined)[] {
  return renderer.root.findAllByType(MobileBrowserFrameLayer)
    .map(layer => opacity(layer.findByType('View').props.style))
}
function load(renderer: ReactTestRenderer, layer: number): void {
  act(() => { renderer.root.findAllByType('Image')[layer].props.onLoad() })
}
function tick(): void {
  act(() => { vi.advanceTimersByTime(MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS) })
}
function makeClient() {
  const subscriptions: Subscription[] = []
  const client = { subscribe: (_method: string, _params: unknown,
    listener: Subscription['listener'], options?: { onBinaryFrame?: Subscription['onBinaryFrame'] }) => {
      const subscription = { listener, onBinaryFrame: options?.onBinaryFrame, unsubscribe: vi.fn() }
      subscriptions.push(subscription)
      return subscription.unsubscribe
    }, request: vi.fn() } as unknown as RpcClient
  return { client, subscriptions }
}
async function mount(client: RpcClient, id: string, nativeCalls?: { type: unknown; props: unknown }[]) {
  const tab: MobileBrowserTab = { type: 'browser', id, title: 'New Browser',
    browserWorkspaceId: 'browser-workspace', browserPageId: id, url: 'about:blank',
    loading: false, canGoBack: false, canGoForward: false, isActive: true }
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(MobileBrowserPane, { client, worktreeId: id, tab,
      screencastSupported: true, keyboardLift: 0, bottomInset: 0, onToast: () => {} }), {
      // Actual Web hosts do not supply setNativeProps. Native still receives the
      // original imperative ref and records its calls instead of React updates.
      createNodeMock: node => nativeCalls
        ? { setNativeProps: (props: unknown) => nativeCalls.push({ type: node.type, props }) }
        : {}
    })
    await Promise.resolve()
  })
  mounted.push(renderer)
  const viewport = renderer.root.findAllByType('View').find(node => typeof node.props.onLayout === 'function')
  if (!viewport) {
    throw new Error('Viewport with onLayout not found')
  }
  act(() => { viewport.props.onLayout({ nativeEvent: { layout: { width: 360, height: 640 } } }) })
  return renderer
}

describe('Browser frame presentation with Web refs lacking setNativeProps', () => {
  it('keeps the decoded layer until load and presents the final coalesced frame', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const { client, subscriptions } = makeClient()
    const renderer = await mount(client, 'web-final-frame')
    const stream = subscriptions[0]
    act(() => { stream.onBinaryFrame?.(frame('first')) })
    expect(sources(renderer)[0]).toBe(uri('first'))
    expect(visible(renderer)).toEqual([1, 0])
    load(renderer, 0)
    tick()
    act(() => { stream.onBinaryFrame?.(frame('second')) })
    expect(sources(renderer)).toEqual([uri('first'), uri('second')])
    expect(renderer.root.findAllByType('Image')[1].props.source).toEqual({ uri: uri('second') })
    expect(visible(renderer)).toEqual([1, 0])
    tick()
    act(() => { stream.onBinaryFrame?.(frame('latest-before-load')) })
    expect(sources(renderer)).toEqual([uri('first'), uri('latest-before-load')])
    expect(visible(renderer)).toEqual([1, 0])
    load(renderer, 1)
    expect(visible(renderer)).toEqual([0, 1])
    act(() => {
      stream.onBinaryFrame?.(frame('coalesced-away'))
      stream.onBinaryFrame?.(frame('final-static'))
    })
    expect(sources(renderer)[0]).toBe(uri('first'))
    tick()
    expect(sources(renderer)).toEqual([uri('final-static'), uri('latest-before-load')])
    expect(visible(renderer)).toEqual([0, 1])
    load(renderer, 0)
    expect(visible(renderer)).toEqual([1, 0])
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0)
  })

  it('preserves the visible frame on decode error, restores cache and ignores the old stream', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const { client, subscriptions } = makeClient()
    const renderer = await mount(client, 'web-cache-frame')
    const stream = subscriptions[0]
    act(() => { stream.onBinaryFrame?.(frame('visible')) })
    load(renderer, 0); tick()
    act(() => { stream.onBinaryFrame?.(frame('bad-hidden')) })
    act(() => { renderer.root.findAllByType('Image')[1].props.onError() })
    expect(visible(renderer)).toEqual([1, 0])
    tick()
    act(() => { stream.onBinaryFrame?.(frame('recovered')) })
    expect(sources(renderer)[1]).toBe(uri('recovered'))
    load(renderer, 1)
    act(() => { renderer.unmount() })
    mounted.splice(mounted.indexOf(renderer), 1)
    expect(stream.unsubscribe).toHaveBeenCalledOnce()
    const remounted = await mount(client, 'web-cache-frame')
    expect(sources(remounted)[0]).toBe(uri('recovered'))
    expect(visible(remounted)).toEqual([1, 0])
    act(() => { stream.onBinaryFrame?.(frame('obsolete-stream')) })
    expect(sources(remounted)[0]).toBe(uri('recovered'))
  })

  it('retains native image and opacity imperative updates', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); platform.os = 'android'
    const calls: { type: unknown; props: unknown }[] = []
    const { client, subscriptions } = makeClient()
    const renderer = await mount(client, 'native-frame', calls)
    act(() => { subscriptions[0].onBinaryFrame?.(frame('native-first')) })
    load(renderer, 0); tick()
    act(() => { subscriptions[0].onBinaryFrame?.(frame('native-second')) })
    expect(calls).toContainEqual({ type: 'Image', props: {
      source: [{ uri: uri('native-second') }], src: [{ uri: uri('native-second') }] } })
    load(renderer, 1)
    expect(calls).toContainEqual({ type: 'View', props: { style: { opacity: 1 } } })
    expect(calls).toContainEqual({ type: 'View', props: { style: { opacity: 0 } } })
  })
})
