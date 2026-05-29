import { fireEvent, render, screen } from '@testing-library/react'

import QuickTutorial from '../components/QuickTutorial'
import { I18nProvider } from '../ctx/I18nContext'

function renderTutorial() {
  return render(
    <I18nProvider>
      <QuickTutorial />
    </I18nProvider>
  )
}

describe('QuickTutorial', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.localStorage.setItem('ui-language', 'de')
  })

  test('shows the first-visit prompt and persists dismissal', () => {
    const { unmount } = renderTutorial()

    expect(screen.getByText('Erstbesuch')).toBeInTheDocument()
    expect(screen.getByText('Kurz durch den LotusAnalyzer fuehren lassen?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Spaeter' }))

    expect(screen.queryByText('Erstbesuch')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('lotus-analyzer-onboarding-v1')).toBe('seen')

    unmount()
    renderTutorial()

    expect(screen.queryByText('Erstbesuch')).not.toBeInTheDocument()
  })

  test('walks through the guided tour steps', () => {
    renderTutorial()

    fireEvent.click(screen.getByRole('button', { name: 'Tour starten' }))

    expect(screen.getByRole('dialog', { name: 'Schnell-Tutorial' })).toBeInTheDocument()
    expect(screen.getByText('Schritt 1 von 6')).toBeInTheDocument()
    expect(screen.getByText('1. Datenbestand eingrenzen')).toBeInTheDocument()
    expect(screen.getByText('Dashboard')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))

    expect(screen.getByText('Schritt 2 von 6')).toBeInTheDocument()
    expect(screen.getByText('2. Auffaelligkeiten finden')).toBeInTheDocument()
    expect(screen.getByText('Events und Incidents')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Zurueck' }))

    expect(screen.getByText('Schritt 1 von 6')).toBeInTheDocument()
    expect(screen.getByText('1. Datenbestand eingrenzen')).toBeInTheDocument()
  })
})