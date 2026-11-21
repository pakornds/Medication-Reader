import type { RegionBounds } from '../../api/contracts'
import { InputField } from '../../components/ui/InputField'
import { Button } from '../../components/ui/Button'
import { useRef, useState } from 'react'
import { LuCamera, LuImagePlus, LuUpload } from 'react-icons/lu'
import { PhotoItems } from './PhotoItems'
import type { Photo, PhotoKind } from './draft'
import type { IntakeText } from '../../i18n/intake'

type Props = {
  kind: PhotoKind
  photo?: Photo
  photos: Photo[]
  t: IntakeText
  proposePhoto?: (photo: Photo) => Promise<RegionBounds[]>
  onReplace: (next?: Photo) => void
  onEdit: (next: Photo) => void
}
export function PhotoSlot({ kind, photo, photos, t, onReplace, onEdit, proposePhoto }: Props) {
  const [error, setError] = useState(false)
  const browse = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  function choose(file?: File) {
    if (!file) return
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      !file.size ||
      file.size >= 16_000_000
    ) {
      setError(true)
      return
    }
    setError(false)
    onReplace({ id: crypto.randomUUID(), kind, file, regions: [], date: '' })
  }
  const filePicker = (capture: boolean) => (
    <input
      type="file"
      hidden
      accept="image/jpeg,image/png,image/webp"
      ref={capture ? camera : browse}
      aria-label={capture ? t.camera : t.browse}
      capture={capture ? 'environment' : undefined}
      onChange={(event) => {
        choose(event.target.files?.[0])
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
        choose(e.dataTransfer.files[0])
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
          <LuImagePlus aria-hidden="true" />
          <strong>{t.emptySlot}</strong>
          <small>{t.formats}</small>
        </div>
      )}
      <div className="actions">
        {filePicker(false)}
        {filePicker(true)}
        <Button onClick={() => browse.current?.click()}>
          <LuUpload />
          {photo ? t.replace : t.browse}
        </Button>
        <Button variant="text" onClick={() => camera.current?.click()}>
          <LuCamera />
          {t.camera}
        </Button>
        {(photo || kind === 'additional_photo') && (
          <Button
            variant="text"
            aria-label={[t.remove, t[kind], photo?.file.name].filter(Boolean).join(' ')}
            onClick={() => onReplace()}
          >
            {t.remove}
          </Button>
        )}
      </div>
      {error && <p role="alert">{t.badPhoto}</p>}
    </section>
  )
}
