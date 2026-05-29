import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AIChatProvider } from './ctx/AIChatContext'
import { SourceFilterProvider } from './ctx/SourceFilterContext'
import { FeatureFlagsProvider } from './ctx/FeatureFlagsContext'
import { ThemeProvider } from './ctx/ThemeContext'
import { I18nProvider } from './ctx/I18nContext'
import { SocAlertModalProvider } from './ctx/SocAlertModalContext'
import SocAlertModalStack from './components/SocAlertModalStack'
import { useSocAlertListener } from './lib/useSocAlertListener'
import Layout from './components/Layout'
import ErrorBoundary from './components/ErrorBoundary'
import DashboardPage from './pages/DashboardPage'
import EventsPage from './pages/EventsPage'
import IncidentsPage from './pages/IncidentsPage'
import RulesPage from './pages/RulesPage'
import SourcesPage from './pages/SourcesPage'
import AIChatPage from './pages/AIChatPage'
import UploadPage from './pages/UploadPage'

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 0 } },
})

export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/"
        element={(
          <ErrorBoundary>
            <Layout />
          </ErrorBoundary>
        )}
      >
        <Route index element={<DashboardPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="incidents" element={<IncidentsPage />} />
        <Route path="rules" element={<RulesPage />} />
        <Route path="sources" element={<SourcesPage />} />
        <Route path="upload" element={<UploadPage />} />
        <Route path="ai" element={<AIChatPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function SocAlertRuntime() {
  useSocAlertListener()
  return <SocAlertModalStack />
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ThemeProvider>
          <FeatureFlagsProvider>
            <SourceFilterProvider>
              <AIChatProvider>
                <SocAlertModalProvider>
                  <BrowserRouter>
                    <AppRoutes />
                  </BrowserRouter>
                  <SocAlertRuntime />
                </SocAlertModalProvider>
              </AIChatProvider>
            </SourceFilterProvider>
          </FeatureFlagsProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  )
}
