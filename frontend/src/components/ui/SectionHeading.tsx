type Props = { id: string; title: string; description: string }

export function SectionHeading({ id, title, description }: Props) {
  return (
    <header className="section-heading">
      <h2 id={id}>{title}</h2>
      <p className="hint">{description}</p>
    </header>
  )
}
