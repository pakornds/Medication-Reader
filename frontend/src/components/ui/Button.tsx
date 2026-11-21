import type { ComponentProps } from 'react'

const styles = {
  primary: 'primary-btn',
  secondary: 'btn',
  text: 'text-action',
  preference: 'preference-button',
}

type Props = ComponentProps<'button'> & { variant?: keyof typeof styles }

export function Button({ variant = 'secondary', type = 'button', className, ...props }: Props) {
  return (
    <button type={type} className={[styles[variant], className].filter(Boolean).join(' ')} {...props} />
  )
}
