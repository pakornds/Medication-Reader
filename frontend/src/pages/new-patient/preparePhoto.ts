export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,.jpg,.jpeg,.png,.webp'
export const MAX_ORIGINAL_PHOTO_BYTES = 50_000_000
export const MAX_BATCH_PHOTO_BYTES = 38_000_000

const MAX_PREPARED_BYTES = 3_750_000
const MAX_PREPARED_PIXELS = 24_000_000
const PHOTO_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
type PhotoMime = keyof typeof PHOTO_EXTENSIONS
type PhotoFormat = PhotoMime | 'heif'

const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))

function photoFormat(bytes: Uint8Array): PhotoFormat {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brands = [ascii(bytes, 8, 12)]
    const boxSize = new DataView(bytes.buffer).getUint32(0)
    for (let index = 16; index + 4 <= Math.min(boxSize, bytes.length); index += 4) {
      brands.push(ascii(bytes, index, index + 4))
    }
    if (brands.some(brand => /^(hei[cxms]|hev[cxms]|m[is]f1)$/.test(brand))) return 'heif'
  }
  throw new Error('Unsupported photo format')
}

function asUpload(blob: Blob, original: File, mime: PhotoMime) {
  const base = original.name.replace(/\.[^.]+$/, '') || 'photo'
  return new File([blob], base + '.' + PHOTO_EXTENSIONS[mime], { type: mime, lastModified: original.lastModified })
}

async function canPassThrough(file: File, header: Uint8Array, mime: PhotoMime) {
  if (mime === 'image/webp') {
    return header.length >= 20 && new DataView(header.buffer).getUint32(4, true) + 8 === file.size
  }
  const tail = new Uint8Array(await file.slice(mime === 'image/jpeg' ? -2 : -12).arrayBuffer())
  return mime === 'image/jpeg'
    ? startsWith(tail, [0xff, 0xd9])
    : startsWith(header.subarray(8), [0, 0, 0, 13, 73, 72, 68, 82])
      && startsWith(tail, [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('Could not prepare photo')),
    'image/jpeg', quality,
  ))
}

export async function preparePhoto(file: File, signal: AbortSignal): Promise<File> {
  const header = new Uint8Array(await file.slice(0, 512).arrayBuffer())
  const format = photoFormat(header)
  const typedFile = file.slice(0, file.size, format === 'heif' ? 'image/heic' : format)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(typedFile, { imageOrientation: 'from-image' })
  } catch (error) {
    signal.throwIfAborted()
    if (format !== 'heif') throw error
    const { heicTo } = await import('heic-to/next')
    signal.throwIfAborted()
    bitmap = await heicTo({ blob: typedFile, type: 'bitmap' })
  }
  try {
    signal.throwIfAborted()
    const scale = Math.min(1, Math.sqrt(MAX_PREPARED_PIXELS / (bitmap.width * bitmap.height)),
      6000 / Math.max(bitmap.width, bitmap.height))
    if (format !== 'heif' && scale === 1 && file.size <= MAX_PREPARED_BYTES
        && await canPassThrough(file, header, format)) {
      return file.type === format ? file : asUpload(typedFile, file, format)
    }

    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 0
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Could not prepare photo')
    try {
      for (const [size, quality] of [[1, 0.92], [1, 0.82], [0.8, 0.82], [0.6, 0.82]]) {
        signal.throwIfAborted()
        const width = Math.max(1, Math.floor(bitmap.width * scale * size))
        const height = Math.max(1, Math.floor(bitmap.height * scale * size))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
          context.fillStyle = '#fff'
          context.fillRect(0, 0, width, height)
          context.drawImage(bitmap, 0, 0, width, height)
        }
        const jpeg = await encodeJpeg(canvas, quality)
        if (jpeg.size <= MAX_PREPARED_BYTES) return asUpload(jpeg, file, 'image/jpeg')
      }
      throw new Error('Could not fit photo within the upload size')
    } finally {
      canvas.width = canvas.height = 1
    }
  } finally {
    bitmap.close()
  }
}
