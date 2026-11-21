import type { ReactNode } from 'react'

export function PageContainer({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[90rem] px-4 md:px-5 xl:px-16">{children}</div>
}
