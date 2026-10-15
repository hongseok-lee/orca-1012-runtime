import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useState,
  type ForwardedRef
} from 'react'
import { Image, Platform, View, type ImageProps, type ImageSourcePropType, type ViewProps } from 'react-native'

export type BrowserFrameImageRef = {
  setNativeProps: (props: { source: ImageSourcePropType; src: ImageSourcePropType }) => void
}
export type BrowserFrameLayerRef = {
  setNativeProps: (props: { style: { opacity: number } }) => void
}

function forwardNativeRef<T>(ref: ForwardedRef<T>, node: T | null): void {
  if (typeof ref === 'function') {
    ref(node)
  } else if (ref) {
    ref.current = node
  }
}

const WebFrameImage = forwardRef<BrowserFrameImageRef, ImageProps>(function WebFrameImage(
  props,
  ref
) {
  // Each layer owns its source: a new hidden frame must not replace the visible
  // layer before it decodes. Ref attachment also restores cached/remounted frames.
  const [source, setSource] = useState(props.source)
  useImperativeHandle(
    ref,
    () => ({
      // Native accepts a source array; Web's Image resolves the uri object.
      setNativeProps: (next) => setSource(Array.isArray(next.source) ? next.source[0] : next.source)
    }),
    []
  )
  return <Image {...props} source={source} />
})

const WebFrameLayer = forwardRef<BrowserFrameLayerRef, ViewProps>(function WebFrameLayer(
  props,
  ref
) {
  const [opacity, setOpacity] = useState<number | null>(null)
  useImperativeHandle(
    ref,
    () => ({ setNativeProps: (next) => setOpacity(next.style.opacity) }),
    []
  )
  return <View {...props} style={opacity === null ? props.style : [props.style, { opacity }]} />
})

export const MobileBrowserFrameImage = forwardRef<BrowserFrameImageRef, ImageProps>(
  function MobileBrowserFrameImage(props, ref) {
    const nativeRef = useCallback((node: Image | null) => forwardNativeRef(ref, node), [ref])
    return Platform.OS === 'web' ? (
      <WebFrameImage {...props} ref={ref} />
    ) : (
      <Image {...props} ref={nativeRef} />
    )
  }
)

export const MobileBrowserFrameLayer = forwardRef<BrowserFrameLayerRef, ViewProps>(
  function MobileBrowserFrameLayer(props, ref) {
    const nativeRef = useCallback((node: View | null) => forwardNativeRef(ref, node), [ref])
    return Platform.OS === 'web' ? (
      <WebFrameLayer {...props} ref={ref} />
    ) : (
      <View {...props} ref={nativeRef} />
    )
  }
)
