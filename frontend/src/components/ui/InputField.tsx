import type { ComponentProps } from 'react'

type Props = ComponentProps<'input'> & { label: string }

export function InputField({ label, ...props }: Props) {
  return (
    <label className="field-label">
      {label}
      <input {...props} />
    </label>
  )
}
