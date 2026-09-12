import { useState } from 'react';
import { Cable, Headphones, LogOut, Mic, MonitorUp, SlidersHorizontal, SunMoon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
} from '@/components/ui/sidebar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import SettingsScreen, { type SettingsPage } from '@/features/settings/SettingsScreen';
import type { User } from '@/api';

const pages = [
  { id: 'audio', label: 'Audio', note: 'Quick call controls', icon: Mic },
  { id: 'voice', label: 'Voice & devices', note: 'Microphone, speakers and camera', icon: Headphones },
  { id: 'recording', label: 'Recording', note: 'Saved video quality', icon: MonitorUp },
  { id: 'stream', label: 'Streaming', note: 'Quality while sharing', icon: SlidersHorizontal },
  { id: 'connection', label: 'Connection', note: 'How calls reach your friends', icon: Cable },
  { id: 'appearance', label: 'Appearance', note: 'Theme and camera layout', icon: SunMoon },
] as const satisfies ReadonlyArray<{ id: SettingsPage; label: string; note: string; icon: typeof Mic }>;

export function SettingsDialog({ open, onOpenChange, user, noise, onNoiseChange, balanced, onBalancedChange, layout, onLayoutChange, signedIn, onSignOut }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User | null;
  noise: boolean;
  onNoiseChange: (value: boolean) => void;
  balanced: boolean;
  onBalancedChange: (value: boolean) => void;
  layout: string;
  onLayoutChange: (value: string) => void;
  signedIn: boolean;
  onSignOut: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>('audio');
  const current = pages.find((item) => item.id === page) ?? pages[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog h-[min(760px,calc(100dvh-2rem))] overflow-hidden p-0 sm:max-w-[min(1040px,calc(100vw-2rem))]" showCloseButton>
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Adjust BetterComms preferences.</DialogDescription>
        <SidebarProvider className="min-h-0 items-stretch [--sidebar-width:15rem]">
          <Sidebar collapsible="none" className="hidden border-r border-sidebar-border md:flex">
            <SidebarContent className="pt-3">
              <SidebarGroup>
                <SidebarGroupLabel>Settings</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {pages.map(({ id, label, icon: Icon }) => (
                      <SidebarMenuItem key={id}>
                        <SidebarMenuButton isActive={page === id} onClick={() => setPage(id)} tooltip={label}>
                          <Icon />
                          <span>{label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
            {signedIn && (
              <SidebarFooter>
                <SidebarMenu><SidebarMenuItem>
                  <SidebarMenuButton onClick={onSignOut}><LogOut /><span>Sign out</span></SidebarMenuButton>
                </SidebarMenuItem></SidebarMenu>
              </SidebarFooter>
            )}
          </Sidebar>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            <header className="shrink-0 border-b border-border/60 px-5 py-4 pr-16 sm:px-7 sm:pr-16">
              <div className="mb-3 md:hidden">
                <Select value={page} onValueChange={(value) => { if (value) setPage(value as SettingsPage); }}>
                  <SelectTrigger className="w-full"><SelectValue>{current.label}</SelectValue></SelectTrigger>
                  <SelectContent align="start">
                    {pages.map(({ id, label }) => <SelectItem key={id} value={id}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {/* The note was behind an info button here and printed again
                  inside the page's card. One copy, in plain sight. */}
              <h2 className="font-heading text-lg font-semibold tracking-tight">{current.label}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{current.note}</p>
            </header>
            {/*
              Settings does not animate. The dialog already has an entrance, and
              sliding the panel again on top of it read as one action playing
              twice; switching pages in a settings list is navigation between
              forms, where a transition costs time and returns nothing.
            */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3 sm:px-7 sm:py-4">
              <SettingsScreen page={page} user={user} noise={noise} onNoiseChange={onNoiseChange} balanced={balanced} onBalancedChange={onBalancedChange} layout={layout} onLayoutChange={onLayoutChange} />
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
