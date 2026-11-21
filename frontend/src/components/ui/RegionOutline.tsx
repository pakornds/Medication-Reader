// Coordinates are percentages of the displayed image, measured from its top-left corner.
export type PercentBox = { x: number; y: number; w: number; h: number }

export function RegionOutline({ box, number }: { box: PercentBox; number?: number }) {
  return (
    <span
      className="region-box"
      style={{ left: box.x + '%', top: box.y + '%', width: box.w + '%', height: box.h + '%' }}
    >
      {number !== undefined && <b>{number}</b>}
    </span>
  )
}
