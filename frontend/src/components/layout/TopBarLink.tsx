import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'

export function TopBarLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink to={to} className="workspace-link">
      {children}
    </NavLink>
  )
}
