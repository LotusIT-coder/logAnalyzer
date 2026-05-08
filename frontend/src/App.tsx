import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './ctx/AuthContext'
import { AIChatProvider } from './ctx/AIChatContext'
import { SourceFilterProvider } from './ctx/SourceFilterContext'
import { useAuth } from './ctx/useAuth'
import Layout from './components/Layout'
import DashboardPage from './pages/DashboardPage'
import EventsPage from './pages/EventsPage'
import IncidentsPage from './pages/IncidentsPage'
import RulesPage from './pages/RulesPage'
import SourcesPage from './pages/SourcesPage'
import AIChatPage from './pages/AIChatPage'
import UploadPage from './pages/UploadPage'
import AccessPage from './pages/AccessPage'
import LoginPage from './pages/LoginPage'

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

function RouteLoadingScreen() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: '#0f172a', color: '#cbd5e1' }}>
      Sitzung wird geladen...
    </div>
  )
}

function ProtectedRoute() {
  const { me, isLoading } = useAuth()

  if (isLoading) return <RouteLoadingScreen />
  if (!me) return <Navigate to="/login" replace />
  return <Outlet />
}

function LoginRoute() {
  const { me, isLoading } = useAuth()

  if (isLoading) return <RouteLoadingScreen />
  if (me) return <Navigate to="/" replace />
  return <LoginPage />
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="incidents" element={<IncidentsPage />} />
          <Route path="rules" element={<RulesPage />} />
          <Route path="sources" element={<SourcesPage />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="ai" element={<AIChatPage />} />
          <Route path="access" element={<AccessPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <SourceFilterProvider>
          <AIChatProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </AIChatProvider>
        </SourceFilterProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
