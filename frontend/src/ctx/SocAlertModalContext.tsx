import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'

export interface SocAlertModal {
  id: string
  title: string
  message: string
  timestamp: string
  details?: any
}

interface SocAlertModalContextType {
  modals: SocAlertModal[]
  showModal: (modal: SocAlertModal) => void
  closeModal: (id: string) => void
}

const SocAlertModalContext = createContext<SocAlertModalContextType | undefined>(undefined)

export function useSocAlertModal() {
  const ctx = useContext(SocAlertModalContext)
  if (!ctx) throw new Error('useSocAlertModal must be used within SocAlertModalProvider')
  return ctx
}

export function SocAlertModalProvider({ children }: { children: ReactNode }) {
  const [modals, setModals] = useState<SocAlertModal[]>([])

  const showModal = useCallback((modal: SocAlertModal) => {
    setModals(prev => [...prev, modal])
  }, [])

  const closeModal = useCallback((id: string) => {
    setModals(prev => prev.filter(m => m.id !== id))
  }, [])

  return (
    <SocAlertModalContext.Provider value={{ modals, showModal, closeModal }}>
      {children}
    </SocAlertModalContext.Provider>
  )
}
