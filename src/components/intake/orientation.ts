// The original bytes travel to the server. The browser displays them after EXIF orientation.
function tiffOrientation(bytes: DataView, start: number, end: number): number {
  if (end - start >= 6 && bytes.getUint32(start) === 0x45786966 && bytes.getUint16(start + 4) === 0) start += 6
  if (end - start < 8) return 1
  const little = bytes.getUint16(start) === 0x4949
  if ((!little && bytes.getUint16(start) !== 0x4d4d) || bytes.getUint16(start + 2, little) !== 42) return 1
  const directory = start + bytes.getUint32(start + 4, little)
  if (directory + 2 > end) return 1
  const count = bytes.getUint16(directory, little)
  for (let i = 0; i < count; i++) {
    const entry = directory + 2 + i * 12
    if (entry + 12 > end) break
    if (bytes.getUint16(entry, little) !== 0x112 || bytes.getUint16(entry + 2, little) !== 3 ||
        bytes.getUint32(entry + 4, little) !== 1) continue
    const value = bytes.getUint16(entry + 8, little)
    return value >= 1 && value <= 8 ? value : 1
  }
  return 1
}

export async function imageOrientation(file: File): Promise<number> {
  const b = new DataView(await file.arrayBuffer())
  if (b.byteLength < 12) return 1
  if (b.getUint16(0) === 0xffd8) {
    let pos = 2
    while (pos + 4 <= b.byteLength && b.getUint8(pos) === 0xff) {
      while (pos < b.byteLength && b.getUint8(pos) === 0xff) pos++
      if (pos + 3 > b.byteLength) break
      const marker = b.getUint8(pos++)
      if (marker === 0xda || marker === 0xd9) break
      const size = b.getUint16(pos)
      if (size < 2 || pos + size > b.byteLength) break
      if (marker === 0xe1 && size >= 8 && b.getUint32(pos + 2) === 0x45786966)
        return tiffOrientation(b, pos + 2, pos + size)
      pos += size
    }
  } else if (b.getUint32(0) === 0x89504e47) {
    for (let pos = 8; pos + 12 <= b.byteLength;) {
      const size = b.getUint32(pos)
      if (pos + 12 + size > b.byteLength) break
      if (b.getUint32(pos + 4) === 0x65584966) return tiffOrientation(b, pos + 8, pos + 8 + size)
      pos += 12 + size
    }
  } else if (b.getUint32(0) === 0x52494646 && b.getUint32(8) === 0x57454250) {
    for (let pos = 12; pos + 8 <= b.byteLength;) {
      const size = b.getUint32(pos + 4, true)
      if (pos + 8 + size > b.byteLength) break
      if (b.getUint32(pos) === 0x45584946) return tiffOrientation(b, pos + 8, pos + 8 + size)
      pos += 8 + size + size % 2
    }
  }
  return 1
}
