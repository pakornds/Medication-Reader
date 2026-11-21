declare module '*package-layout/editor.mjs' {
  export interface CaptureEditor {
    restore(scene: import('../../api/contracts').PackageCapture, urls: Partial<Record<'front' | 'reverse', string>>): void
    snapshot(): import('../../api/contracts').PackageCapture
    dispose(): void
    setPhoto(side: 'front' | 'reverse', photo: { attachment_id: string; url: string; revision: number; exif_orientation: number }): void
    addProposals(side: 'front' | 'reverse', response: { attachment_id: string; revision: number; bounds: import('../../api/contracts').RegionBounds[] }): void
  }
  export function mountPackageLayout(root: HTMLElement, options: {
    caseId: string; onChange: (scene: import('../../api/contracts').PackageCapture) => void
  }): CaptureEditor
}
