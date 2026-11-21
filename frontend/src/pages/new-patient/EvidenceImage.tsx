import { useEffect, useRef, useState } from 'react'
import type { Region } from './draft'

export function EvidenceImage({ file }: { file: File }) {
  const image = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const url = URL.createObjectURL(file)
    if (image.current) image.current.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])
  return <img ref={image} alt={file.name} />
}

export function EvidenceCrop({ file, region, label, unavailable }: {
  file: File
  region: Region
  label: string
  unavailable: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const target = canvas.current
    if (!target) return
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      const { x, y, w, h } = region.box
      const left = image.naturalWidth * x / 100
      const top = image.naturalHeight * y / 100
      const width = image.naturalWidth * w / 100
      const height = image.naturalHeight * h / 100
      const scale = Math.min(1, 1200 / Math.max(width, height))
      target.width = Math.max(1, Math.round(width * scale))
      target.height = Math.max(1, Math.round(height * scale))
      const context = target.getContext('2d')
      if (context) {
        context.drawImage(image, left, top, width, height, 0, 0, target.width, target.height)
      } else {
        setFailed(true)
      }
    }
    image.onerror = () => setFailed(true)
    image.src = url
    return () => {
      image.onload = null
      image.onerror = null
      URL.revokeObjectURL(url)
    }
  }, [file, region])
  return failed ? <p>{unavailable}</p> : (
    <canvas ref={canvas} data-region={region.id} role="img" aria-label={label} width={1} height={1} />
  )
}
