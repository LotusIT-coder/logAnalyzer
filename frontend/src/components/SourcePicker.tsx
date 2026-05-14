import { useQuery, useQueryClient } from '@tanstack/react-query'
import React, { useEffect, useRef, useState } from 'react'
import { deleteSource, getSources, uploadImport, type SourceResponse, type UploadImportResponse } from '../lib/requests'
import { type SourceOption } from '../ctx/SourceFilterContext.shared'
import { getApiErrorMessage } from '../lib/errors'
import { useI18n } from '../ctx/I18nContext'

// ─── Preset log paths ────────────────────────────────────────────────────────
export const PRESET_PATHS = [
  { label: 'syslog',          path: '/var/log/syslog' },
  { label: 'auth.log',        path: '/var/log/auth.log' },
  { label: 'kern.log',        path: '/var/log/kern.log' },
  { label: 'dpkg.log',        path: '/var/log/dpkg.log' },
  { label: 'Nginx access',    path: '/var/log/nginx/access.log' },
  { label: 'Nginx error',     path: '/var/log/nginx/error.log' },
  { label: 'Apache access',   path: '/var/log/apache2/access.log' },
  { label: 'Apache error',    path: '/var/log/apache2/error.log' },
  { label: 'MySQL error',     path: '/var/log/mysql/error.log' },
  { label: 'PostgreSQL',      path: '/var/log/postgresql/postgresql-16-main.log' },
]

export const PRESET_PATH_SET = new Set(PRESET_PATHS.map(p => p.path))

export type UploadResultState = UploadImportResponse | { error: string }

export function isUploadError(result: UploadResultState): result is { error: string } {
  return 'error' in result
}

// ─── Option row ───────────────────────────────────────────────────────────────
export function OptionRow({ opt, checked, onToggle }: { opt: SourceOption; checked: boolean; onToggle: (o: SourceOption) => void }) {
  return (
    <label style={pickerStyles.option}>
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(opt)}
        style={{ accentColor: '#3b82f6', flexShrink: 0 }}
      />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {opt.label}
      </span>
      {opt.kind === 'configured' && (
        <span style={{ color: '#22c55e', fontSize: '0.7rem', flexShrink: 0 }}>●</span>
      )}
    </label>
  )
}

// ─── Source picker dropdown ───────────────────────────────────────────────────
export function SourcePicker({
  selected, onChange, onUploadResult, customSources, onRemoveCustom,
}: {
  selected: SourceOption[]
  onChange: (v: SourceOption[]) => void
  onUploadResult: (r: UploadResultState) => void | Promise<void>
  customSources: SourceOption[]
  onRemoveCustom: (id: string) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const { data: configuredSources = [] } = useQuery({ queryKey: ['sources'], queryFn: getSources })
  const qc = useQueryClient()
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const configuredOptions: SourceOption[] = configuredSources
    .filter((s: SourceResponse) => {
      const origin = s.config?.source_origin
      if (origin === 'preset') return false
      if (!origin && PRESET_PATH_SET.has(s.config?.path ?? '')) return false
      return true
    })
    .map((s: SourceResponse) => ({
      id: `source:${s.id}`,
      label: s.name,
      path: s.config?.path ?? '',
      kind: 'configured' as const,
    }))

  const presetOptions: SourceOption[] = PRESET_PATHS.map(p => ({
    id: `preset:${p.path}`,
    label: p.label,
    path: p.path,
    kind: 'preset' as const,
  }))

  function optionMatches(a: SourceOption, b: SourceOption) {
    if (a.id === b.id) return true
    if (a.path && b.path && a.path === b.path) return true
    return false
  }

  function toggle(opt: SourceOption) {
    const idx = selected.findIndex(s => optionMatches(s, opt))
    if (idx >= 0) onChange(selected.filter((_, i) => i !== idx))
    else onChange([...selected, opt])
  }

  function addCustom() {
    const path = customInput.trim()
    if (!path) return
    const opt: SourceOption = {
      id: `custom:${path}`,
      label: path.split('/').pop() || path,
      path,
      kind: 'custom',
    }
    if (!selected.find(s => s.id === opt.id)) onChange([...selected, opt])
    setCustomInput('')
  }

  const label = selected.length === 0
    ? t('sourcePicker.allConfigured')
    : selected.length === 1
      ? selected[0].label
      : t('sourcePicker.selectedCount', { count: selected.length })

  return (
    <div ref={ref} style={pickerStyles.wrap}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={pickerStyles.trigger}
        title={t('sourcePicker.choose')}
      >
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <span style={{ flexShrink: 0, marginLeft: '0.4rem' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={pickerStyles.dropdown}>
          <div style={pickerStyles.helperNote}>
            {t('sourcePicker.helper')}
          </div>
          {/* Clear selection */}
          <div
            style={{ ...pickerStyles.option, color: '#64748b', borderBottom: '1px solid #334155', paddingBottom: '0.5rem', marginBottom: '0.25rem' }}
            onClick={() => onChange([])}
          >
            ✕ {t('sourcePicker.clearSelection')}
          </div>

          {/* Configured sources */}
          {configuredOptions.length > 0 && (
            <div style={pickerStyles.groupHeader}>{t('sourcePicker.group.configured')}</div>
          )}
          {configuredOptions.map(opt => {
            const rawId = opt.id.replace('source:', '')
            const isPending = pendingDeleteId === rawId
            return (
              <div key={opt.id} style={{ ...pickerStyles.option, justifyContent: 'space-between' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, cursor: 'pointer', minWidth: 0 }}>
                  <input
                    type="checkbox"
                    checked={selected.some(s => optionMatches(s, opt))}
                    onChange={() => toggle(opt)}
                    style={{ accentColor: '#3b82f6', flexShrink: 0 }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
                  <span style={{ color: '#22c55e', fontSize: '0.7rem', flexShrink: 0 }}>●</span>
                </label>
                {isPending ? (
                  <div style={{ display: 'flex', gap: '0.2rem', alignItems: 'center', flexShrink: 0 }}>
                    <span style={{ fontSize: '0.72rem', color: '#fca5a5' }}>{t('sourcePicker.deleteConfirm')}</span>
                    <button
                      onClick={async e => {
                        e.stopPropagation()
                        setPendingDeleteId(null)
                        await deleteSource(rawId)
                        qc.invalidateQueries({ queryKey: ['sources'] })
                        onChange(selected.filter(s => !optionMatches(s, opt)))
                      }}
                      style={{ background: 'none', border: '1px solid #ef4444', color: '#ef4444', cursor: 'pointer', fontSize: '0.72rem', borderRadius: 4, padding: '1px 5px' }}
                    >{t('sourcePicker.yes')}</button>
                    <button
                      onClick={e => { e.stopPropagation(); setPendingDeleteId(null) }}
                      style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '0.72rem', padding: '1px 3px' }}
                    >{t('sourcePicker.cancel')}</button>
                  </div>
                ) : (
                  <button
                    onClick={e => { e.stopPropagation(); setPendingDeleteId(rawId) }}
                    title={t('sourcePicker.delete')}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.85rem', padding: '0 0.15rem', flexShrink: 0, opacity: 0.6 }}
                  >🗑</button>
                )}
              </div>
            )
          })}

          {/* Presets */}
          <div style={pickerStyles.groupHeader}>{t('sourcePicker.group.presets')}</div>
          {presetOptions.map(opt => (
            <OptionRow key={opt.id} opt={opt} checked={selected.some(s => optionMatches(s, opt))} onToggle={toggle} />
          ))}

          {/* Custom / uploaded sources */}
          {customSources.length > 0 && (
            <>
              <div style={pickerStyles.groupHeader}>{t('sourcePicker.group.custom')}</div>
              {customSources.map(opt => (
                <div key={opt.id} style={{ ...pickerStyles.option, justifyContent: 'space-between' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, cursor: 'pointer', minWidth: 0 }}>
                    <input
                      type="checkbox"
                      checked={selected.some(s => optionMatches(s, opt))}
                      onChange={() => toggle(opt)}
                      style={{ accentColor: '#3b82f6', flexShrink: 0 }}
                    />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
                  </label>
                  <button
                    onClick={e => { e.stopPropagation(); onRemoveCustom(opt.id) }}
                    title={t('sourcePicker.remove')}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.9rem', padding: '0 0.2rem', flexShrink: 0 }}
                  >✕</button>
                </div>
              ))}
            </>
          )}

          {/* Add custom path */}
          <div style={pickerStyles.groupHeader}>{t('sourcePicker.group.customPath')}</div>
          <div style={pickerStyles.customRow}>
            <input
              value={customInput}
              onChange={e => setCustomInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addCustom()}
              placeholder="/var/log/meinlog.log"
              style={pickerStyles.customInput}
            />
            <button onClick={addCustom} style={pickerStyles.addBtn}>+</button>
          </div>

          {/* File upload */}
          <div style={{ borderTop: '1px solid #334155', marginTop: '0.5rem', paddingTop: '0.5rem' }}>
            <div style={pickerStyles.groupHeader}>{t('sourcePicker.group.upload')}</div>
            <div style={{ padding: '0.35rem 0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <input ref={fileRef} type="file" accept=".log,.txt,.csv,text/*" style={{ display: 'none' }}
                onChange={async e => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  setUploading(true)
                  try {
                    const r = await uploadImport(file)
                    await onUploadResult(r)
                    setOpen(false)
                  } catch (error: unknown) {
                    await onUploadResult({ error: getApiErrorMessage(error, 'Upload failed') })
                  } finally {
                    setUploading(false)
                    if (fileRef.current) fileRef.current.value = ''
                  }
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                style={{ ...pickerStyles.addBtn, width: '100%', padding: '0.4rem' }}
              >
                {uploading ? t('sourcePicker.uploading') : `📂 ${t('sourcePicker.upload')}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export const pickerStyles: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative', minWidth: 240, maxWidth: 360 },
  trigger: {
    display: 'flex', alignItems: 'center', width: '100%',
    background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '0.5rem 0.75rem', cursor: 'pointer', fontSize: '0.88rem',
  },
  dropdown: {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 100,
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
    boxShadow: '0 8px 32px #0006', padding: '0.5rem', minWidth: 320, maxHeight: 380,
    overflowY: 'auto',
    overflowX: 'hidden',
  },
  helperNote: {
    color: 'var(--muted-fg)',
    fontSize: '0.76rem',
    lineHeight: 1.45,
    padding: '0.45rem 0.55rem 0.65rem',
    borderBottom: '1px solid var(--border)',
    marginBottom: '0.35rem',
  },
  groupHeader: {
    color: 'var(--muted-fg)', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase',
    padding: '0.4rem 0.5rem 0.2rem',
  },
  option: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.35rem 0.5rem', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem',
    color: 'var(--fg)',
    minWidth: 0,
  },
  customRow: { display: 'flex', gap: '0.4rem', padding: '0.35rem 0.5rem' },
  customInput: {
    flex: 1, background: 'var(--surface-2)', color: 'var(--fg)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '0.35rem 0.6rem', fontSize: '0.83rem',
  },
  addBtn: {
    background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6,
    padding: '0.35rem 0.65rem', cursor: 'pointer', fontWeight: 700,
  },
}
