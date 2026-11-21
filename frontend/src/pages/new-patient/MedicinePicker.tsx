import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { LuCheck, LuSearch } from 'react-icons/lu'
import { searchProducts } from '../../api/reconciliation'
import type { IntakeText } from '../../i18n/intake'
import type { CatalogueMatch, Product } from './draft'

type Result = Awaited<ReturnType<typeof searchProducts>> & { term: string }

export function MedicinePicker({ t, name, selected, onChange, onSelect }: {
  t: IntakeText
  name: string
  selected?: CatalogueMatch
  onChange: (value: string) => void
  onSelect: (match: CatalogueMatch) => void
}) {
  const id = useId()
  const listId = id + '-list'
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<Result>()
  const [feedback, setFeedback] = useState<'slow' | 'error'>()
  const [activeCode, setActiveCode] = useState<string>()
  const anchor = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const term = open && !selected ? name.trim().toLowerCase() : ''

  useEffect(() => {
    if (!term || result?.term === term) return
    const controller = new AbortController()
    const slow = window.setTimeout(() => setFeedback('slow'), 450)
    const debounce = window.setTimeout(async () => {
      try {
        const response = await searchProducts(term, controller.signal)
        if (!controller.signal.aborted) setResult({ ...response, term })
      } catch {
        if (!controller.signal.aborted) setFeedback('error')
      } finally {
        window.clearTimeout(slow)
      }
    }, 140)
    return () => {
      controller.abort()
      window.clearTimeout(debounce)
      window.clearTimeout(slow)
    }
  }, [term, result?.term])

  const settled = result?.term === term
  const terms = term.split(/\s+/)
  const previous = result?.products ?? []
  const matches = settled ? previous : previous.filter(p =>
    p.tpu === term || terms.every(word => p.label.toLowerCase().includes(word)),
  )
  // Keep the menu steady while an unrelated query is in flight. Only matching rows can be chosen.
  const waiting = !settled && !matches.length && feedback !== 'error'
  const options = waiting ? previous : matches
  const message = feedback === 'error' && !settled ? t.catalogFail
    : settled && !matches.length ? t.noProducts
    : waiting && feedback === 'slow' ? t.searching : ''
  const visible = Boolean(term && (options.length || message || result))
  const active = matches.find(p => p.tpu === activeCode)
  const optionId = (code: string) => listId + '-' + code

  useLayoutEffect(() => {
    if (!visible || !anchor.current) return
    const field = anchor.current
    const viewport = window.visualViewport
    function placeMenu() {
      const rect = field.getBoundingClientRect()
      const top = viewport?.offsetTop ?? 0
      const bottom = top + (viewport?.height ?? window.innerHeight)
      const above = rect.top - top
      const below = bottom - rect.bottom
      const upwards = below < 240 && above > below
      field.dataset.placement = upwards ? 'above' : 'below'
      field.style.setProperty('--menu-space', Math.max(0, (upwards ? above : below) - 8) + 'px')
    }
    placeMenu()
    window.addEventListener('resize', placeMenu)
    window.addEventListener('scroll', placeMenu, true)
    viewport?.addEventListener('resize', placeMenu)
    viewport?.addEventListener('scroll', placeMenu)
    return () => {
      window.removeEventListener('resize', placeMenu)
      window.removeEventListener('scroll', placeMenu, true)
      viewport?.removeEventListener('resize', placeMenu)
      viewport?.removeEventListener('scroll', placeMenu)
    }
  }, [visible])

  function close() {
    setOpen(false)
    setActiveCode(undefined)
    setFeedback(undefined)
  }

  function choose(product: Product) {
    if (!result) return
    close()
    onSelect({ product, release: result.tmt_release })
  }

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      if (open) event.preventDefault()
      close()
    } else if (event.key === 'Enter' && visible && active) {
      event.preventDefault()
      choose(active)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!name.trim() || selected) return
      event.preventDefault()
      setOpen(true)
      if (!matches.length) return
      const index = matches.findIndex(p => p.tpu === activeCode)
      const next = event.key === 'ArrowDown' ? Math.min(index + 1, matches.length - 1)
        : index < 0 ? matches.length - 1 : Math.max(index - 1, 0)
      setActiveCode(matches[next].tpu)
    }
  }

  useEffect(() => {
    const menu = list.current
    const item = menu?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!menu || !item) return
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight
  }, [active, result])

  return (
    <div className="medicine-picker" ref={anchor}>
      <label className="field-label" htmlFor={id}>{t.query}</label>
      <div className="medicine-control">
        {selected ? <LuCheck aria-hidden="true" /> : <LuSearch aria-hidden="true" />}
        <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={visible}
          aria-controls={visible ? listId : undefined}
          aria-activedescendant={visible && active ? optionId(active.tpu) : undefined}
          autoComplete="off" maxLength={120} value={name} onKeyDown={navigate}
          onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={close}
          onChange={e => {
            setOpen(true)
            setActiveCode(undefined)
            setFeedback(undefined)
            if (!e.target.value.trim()) setResult(undefined)
            onChange(e.target.value)
          }} />
      </div>
      {visible && (
        <div className="medicine-menu">
          <ul className="product-list" role="listbox" id={listId} aria-label={t.query} ref={list}>
            {options.map(p => (
              <li role="option" id={optionId(p.tpu)} key={p.tpu} aria-selected={active?.tpu === p.tpu}
                aria-disabled={waiting} onMouseDown={e => e.preventDefault()}
                onClick={() => { if (!waiting) choose(p) }}>
                <span className="product-name">{p.label}</span>
                <span className="product-detail">
                  <span>{[p.strength, p.dose_form].filter(Boolean).join(' · ')}</span>
                  <span>TPU {p.tpu}{p.active_tmt ? '' : ' · ' + t.historical}</span>
                </span>
              </li>
            ))}
          </ul>
          {message && <p className="medicine-message" role="status">{message}</p>}
        </div>
      )}
    </div>
  )
}
