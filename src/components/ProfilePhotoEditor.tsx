import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Check, ImagePlus, Minus, Plus, X } from 'lucide-react'

type Point = { x: number; y: number }

type Props = {
  imageSrc: string
  initialZoom?: number
  onCancel: () => void
  onReplace: () => void
  onSave: (image: string) => void
  onError: (message: string) => void
  error?: string
}

const OUTPUT_SIZE = 512
const CROP_RATIO = 0.84
export const CIRCULAR_CROP_MIN_ZOOM = CROP_RATIO

function ProfilePhotoEditor({ imageSrc, initialZoom = 1, onCancel, onReplace, onSave, onError, error }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const [viewportSize, setViewportSize] = useState(320)
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null)
  const [zoom, setZoom] = useState(initialZoom)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(([entry]) => setViewportSize(entry.contentRect.width))
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  const baseScale = imageDimensions ? viewportSize / Math.min(imageDimensions.width, imageDimensions.height) : 1
  const imageWidth = imageDimensions ? imageDimensions.width * baseScale * zoom : viewportSize
  const imageHeight = imageDimensions ? imageDimensions.height * baseScale * zoom : viewportSize
  const cropSize = viewportSize * CROP_RATIO
  const clampPan = (point: Point): Point => ({
    x: Math.max(-(imageWidth - cropSize) / (2 * viewportSize), Math.min((imageWidth - cropSize) / (2 * viewportSize), point.x)),
    y: Math.max(-(imageHeight - cropSize) / (2 * viewportSize), Math.min((imageHeight - cropSize) / (2 * viewportSize), point.y)),
  })

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!imageDimensions || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaX = (event.clientX - drag.x) / viewportSize
    const deltaY = (event.clientY - drag.y) / viewportSize
    dragRef.current = { ...drag, x: event.clientX, y: event.clientY }
    setPan((current) => clampPan({ x: current.x + deltaX, y: current.y + deltaY }))
  }

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }

  const savePhoto = () => {
    const image = imageRef.current
    if (!image || !imageDimensions) {
      onError('The selected image is still loading. Please try again.')
      return
    }

    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_SIZE
    canvas.height = OUTPUT_SIZE
    const context = canvas.getContext('2d')
    if (!context) {
      onError('Your browser could not create the cropped image. Please try another browser.')
      return
    }

    const drawWidth = imageDimensions.width * baseScale * zoom * OUTPUT_SIZE / cropSize
    const drawHeight = imageDimensions.height * baseScale * zoom * OUTPUT_SIZE / cropSize
    const offsetX = pan.x * viewportSize * OUTPUT_SIZE / cropSize
    const offsetY = pan.y * viewportSize * OUTPUT_SIZE / cropSize
    context.beginPath()
    context.arc(OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, 0, Math.PI * 2)
    context.clip()
    context.drawImage(
      image,
      (OUTPUT_SIZE - drawWidth) / 2 + offsetX,
      (OUTPUT_SIZE - drawHeight) / 2 + offsetY,
      drawWidth,
      drawHeight,
    )

    try {
      const result = canvas.toDataURL('image/webp', 0.9)
      if (result === 'data:,') throw new Error('The cropped image could not be exported.')
      onSave(result)
    } catch (error) {
      console.error('Could not export the cropped profile photo.', error)
      onError('Your browser could not save this crop. Choose a different image or try another browser.')
    }
  }

  const stageImageStyle = {
    width: `${imageWidth}px`,
    height: `${imageHeight}px`,
    transform: `translate(calc(-50% + ${pan.x * viewportSize}px), calc(-50% + ${pan.y * viewportSize}px))`,
  }
  const previewStyle = (size: number) => ({
    width: `${imageWidth * size / (viewportSize * CROP_RATIO)}px`,
    height: `${imageHeight * size / (viewportSize * CROP_RATIO)}px`,
    transform: `translate(calc(-50% + ${pan.x * size / CROP_RATIO}px), calc(-50% + ${pan.y * size / CROP_RATIO}px))`,
  })

  return (
    <div className="photo-editor-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel()
    }}>
      <section className="photo-editor" role="dialog" aria-modal="true" aria-labelledby="photo-editor-title">
        <header className="photo-editor-header">
          <div><h2 id="photo-editor-title">Adjust profile photo</h2><p>Drag to reposition, then zoom to get it just right.</p></div>
          <button type="button" className="photo-editor-close" aria-label="Cancel editing" onClick={onCancel}><X /></button>
        </header>
        <div className="photo-editor-content">
          <div className="photo-editor-crop-column">
            {error && <div className="alert photo-editor-error" role="alert">{error}</div>}
            <div
              ref={viewportRef}
              className="photo-crop-stage"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              aria-label="Circular crop area. Drag the image to reposition it."
            >
              <img
                ref={imageRef}
                className="photo-crop-image"
                src={imageSrc}
                alt=""
                draggable={false}
                style={stageImageStyle}
                onLoad={(event) => setImageDimensions({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })}
                onError={() => onError('This image could not be opened. Choose a different image file.')}
              />
              <div className="photo-crop-dimmer" />
              <div className="photo-crop-circle" />
              {!imageDimensions && <span className="photo-editor-loading">Loading photo…</span>}
            </div>
            <div className="photo-zoom-control">
              <Minus aria-hidden="true" />
              <input
                type="range"
                min={CROP_RATIO}
                max="3"
                step="0.01"
                value={zoom}
                aria-label="Zoom profile photo"
                onChange={(event) => {
                  const nextZoom = Number(event.currentTarget.value)
                  setZoom(nextZoom)
                  const nextWidth = imageDimensions ? imageDimensions.width * baseScale * nextZoom : viewportSize
                  const nextHeight = imageDimensions ? imageDimensions.height * baseScale * nextZoom : viewportSize
                  setPan((current) => ({
                    x: Math.max(-(nextWidth - cropSize) / (2 * viewportSize), Math.min((nextWidth - cropSize) / (2 * viewportSize), current.x)),
                    y: Math.max(-(nextHeight - cropSize) / (2 * viewportSize), Math.min((nextHeight - cropSize) / (2 * viewportSize), current.y)),
                  }))
                }}
              />
              <Plus aria-hidden="true" />
            </div>
          </div>
          <aside className="photo-editor-preview">
            <strong>Profile preview</strong>
            <div className="photo-final-preview">
              <img src={imageSrc} alt="Preview of the cropped profile photo" style={previewStyle(84)} />
            </div>
            <span>This is how your photo will appear.</span>
          </aside>
        </div>
        <footer className="photo-editor-footer">
          <button type="button" className="btn btn-outline" onClick={onReplace}><ImagePlus />Replace photo</button>
          <div>
            <button type="button" className="btn btn-outline" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={savePhoto} disabled={!imageDimensions}><Check />Save Photo</button>
          </div>
        </footer>
      </section>
    </div>
  )
}

export default ProfilePhotoEditor
