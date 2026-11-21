import type { RegionBounds } from '../../api/contracts'
import { InputField } from '../../components/ui/InputField'
import { Button } from '../../components/ui/Button'
import { useEffect, useRef, useState } from 'react'
import { PhotoItems } from './PhotoItems'
import type { Photo, PhotoKind } from './draft'
import type { IntakeText } from '../../i18n/intake'
import { MAX_ORIGINAL_PHOTO_BYTES, PHOTO_ACCEPT, preparePhoto } from './preparePhoto'

type Props = {
  kind: PhotoKind
  photo?: Photo
  photos: Photo[]
  t: IntakeText
  proposePhoto?: (photo: Photo) => Promise<RegionBounds[]>
  onReplace: (next?: Photo) => void
  onEdit: (next: Photo) => void
  onPreparingChange: (preparing: boolean) => void
}
export function PhotoSlot({ kind, photo, photos, t, onReplace, onEdit, proposePhoto, onPreparingChange }: Props) {
  const [error, setError] = useState<'badPhoto' | 'photoTooLarge'>()
  const [preparing, setPreparing] = useState(false)
  const pending = useRef<AbortController>(null)
  const browse = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  useEffect(() => () => pending.current?.abort(), [])
  async function choose(file?: File) {
    if (!file || pending.current) return
    if (file.size > MAX_ORIGINAL_PHOTO_BYTES) {
      setError('photoTooLarge')
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setError(undefined)
    setPreparing(true)
    onPreparingChange(true)
    try {
      const prepared = await preparePhoto(file, controller.signal)
      if (!controller.signal.aborted) onReplace({ id: crypto.randomUUID(), kind, file: prepared, regions: [], date: '' })
    } catch {
      if (!controller.signal.aborted) setError('badPhoto')
    } finally {
      pending.current = null
      if (!controller.signal.aborted) setPreparing(false)
      onPreparingChange(false)
    }
  }
  const filePicker = (capture: boolean) => (
    <input
      type="file"
      hidden
      accept={PHOTO_ACCEPT}
      ref={capture ? camera : browse}
      aria-label={capture ? t.camera : t.browse}
      capture={capture ? 'environment' : undefined}
      onChange={(event) => {
        void choose(event.target.files?.[0])
        event.target.value = ''
      }}
    />
  )
  return (
    <section
      id={photo?.id}
      tabIndex={-1}
      aria-label={t[kind]}
      className="photo-slot stack"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        void choose(e.dataTransfer.files[0])
      }}
    >
      <div className="spread">
        <h3>{t[kind]}</h3>
        {kind !== 'label_photo' && <small>{t.optional}</small>}
      </div>
      {photo ? (
        <>
          <PhotoItems
            key={photo.id}
            proposePhoto={proposePhoto}
            photo={photo}
            photos={photos}
            t={t}
            onChange={(regions) => onEdit({ ...photo, regions })}
          />
          <InputField
            label={t.date}
            type="date"
            value={photo.date}
            onChange={(e) => onEdit({ ...photo, date: e.target.value })}
          />
        </>
      ) : (
        <div className="drop-area">
          <strong>{t.emptySlot}</strong>
          <small>{t.formats}</small>
        </div>
      )}
      <div className="actions">
        {filePicker(false)}
        {filePicker(true)}
        <Button disabled={preparing} onClick={() => browse.current?.click()}>
          {photo ? t.replace : t.browse}
        </Button>
        <Button variant="text" disabled={preparing} onClick={() => camera.current?.click()}>
          {t.camera}
        </Button>
        {(photo || kind === 'additional_photo') && (
          <Button
            variant="text"
            disabled={preparing}
            aria-label={[t.remove, t[kind], photo?.file.name].filter(Boolean).join(' ')}
            onClick={() => onReplace()}
          >
            {t.remove}
          </Button>
        )}
      </div>
      {preparing && <p role="status">{t.preparingPhoto}</p>}
      {error && <p role="alert">{t[error]}</p>}
    </section>
  )
}
