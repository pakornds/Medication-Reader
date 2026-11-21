import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'

export function TopBarLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink to={to} end={to === '/'}
      className="inline-flex min-h-10 items-center gap-1 rounded-lg px-3 text-sm text-2 hover:bg-hover aria-[current=page]:bg-selected aria-[current=page]:font-semibold aria-[current=page]:text-accent">
      {children}
    </NavLink>
  )
}
