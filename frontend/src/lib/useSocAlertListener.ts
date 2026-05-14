import { useEffect } from 'react'
import { useSocAlertModal } from '../ctx/SocAlertModalContext'

// This hook polls for new SOC alerts and shows a modal for each new alert.
// In production, replace polling with SSE or WebSocket for real-time alerts.
export function useSocAlertListener() {
  const { showModal } = useSocAlertModal()

  useEffect(() => {
    const shownIncidentIds = new Set<string>()
    let active = true

    function toNaturalSuspicion(summary: string, severity: string) {
      if (summary?.trim()) return summary
      const severityLabel = severity || 'unbekannt'
      return `Die KI hat ein Muster als potenzielle Bedrohung eingestuft (Severity: ${severityLabel}). Bitte den Vorfall pruefen.`
    }

    async function poll() {
      while (active) {
        try {
          const res = await fetch('/api/v1/incidents?status=open')
          const data = await res.json()
          const items = Array.isArray(data?.items) ? data.items : []
          const aiSocIncidents = items.filter((incident: any) => {
            const tags = Array.isArray(incident?.tags) ? incident.tags : []
            return tags.includes('ai_soc')
          })

          for (let i = aiSocIncidents.length - 1; i >= 0; i -= 1) {
            const incident = aiSocIncidents[i]
            const incidentId = String(incident.id ?? '')
            if (!incidentId || shownIncidentIds.has(incidentId)) continue
            shownIncidentIds.add(incidentId)

            const summary = String(incident.summary ?? '').trim()
            const severity = String(incident.severity ?? '').trim()
            const title = String(incident.title ?? 'SOC Analyst Alarm')
            const timestamp = String(incident.last_seen ?? incident.created_at ?? '')
            const suspicion = toNaturalSuspicion(summary, severity)

            showModal({
              id: incidentId,
              title,
              message: 'Die KI-Ueberwachung hat einen neuen sicherheitsrelevanten Vorfall erkannt.',
              timestamp,
              details: {
                ...incident,
                suspicion,
                event_type: 'ai_soc_incident',
                source_name: '',
                host: '',
              },
            })
          }
        } catch (e) {
          // ignore
        }
        await new Promise(r => setTimeout(r, 3000))
      }
    }
    poll()
    return () => { active = false }
  }, [showModal])
}
