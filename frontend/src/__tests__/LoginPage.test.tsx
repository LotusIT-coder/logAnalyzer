import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'

import LoginPage from '../pages/LoginPage'
import { AuthProvider } from '../ctx/AuthContext'

function renderPage(login = vi.fn().mockResolvedValue(undefined)) {
  render(
    <AuthProvider value={{ me: null, isLoading: false, login, logout: vi.fn() }}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>Dashboard</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  )

  return { login }
}

describe('LoginPage', () => {
  test('submits email and password and navigates to dashboard', async () => {
    const { login } = renderPage()

    fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'alice@example.com' } })
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'Str0ng!Pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }))

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('alice@example.com', 'Str0ng!Pass')
    })

    expect(await screen.findByText('Dashboard')).toBeInTheDocument()
  })

  test('renders login errors', async () => {
    const login = vi.fn().mockRejectedValue(new Error('Unauthorized'))
    renderPage(login)

    fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'alice@example.com' } })
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'broken-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }))

    expect(await screen.findByText('Anmeldung fehlgeschlagen.')).toBeInTheDocument()
  })
})