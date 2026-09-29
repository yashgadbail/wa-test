import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

type AppState = {
  activeChatId: string | null
  sidebarView: 'chats' | 'groups' | 'status'
  search: string
  chatFilter: 'all' | 'unread' | 'archived'
  drafts: Record<string, string>
  pairingPhone: string
  setActiveChat: (jid: string | null) => void
  setSidebarView: (view: 'chats' | 'groups' | 'status') => void
  setSearch: (value: string) => void
  setChatFilter: (value: 'all' | 'unread' | 'archived') => void
  setDraft: (jid: string, value: string) => void
  setPairingPhone: (value: string) => void
}

export const useAppState = create<AppState>()(persist((set) => ({
  activeChatId: null,
  sidebarView: 'chats',
  search: '',
  chatFilter: 'all',
  drafts: {},
  pairingPhone: '',
  setActiveChat: (activeChatId) => set({ activeChatId }),
  setSidebarView: (sidebarView) => set({ sidebarView }),
  setSearch: (search) => set({ search }),
  setChatFilter: (chatFilter) => set({ chatFilter }),
  setDraft: (jid, value) => set((state) => ({ drafts: { ...state.drafts, [jid]: value } })),
  setPairingPhone: (pairingPhone) => set({ pairingPhone }),
}), {
  name: 'wa-desk-preferences',
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({
    activeChatId: state.activeChatId,
    sidebarView: state.sidebarView,
    chatFilter: state.chatFilter,
    drafts: state.drafts,
    pairingPhone: state.pairingPhone,
  }),
}))
