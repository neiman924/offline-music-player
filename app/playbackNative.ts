'use client'

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

type PlaybackDetails = { title: string; artist: string; album: string; playing: boolean }

interface PlaybackNotificationPlugin {
  requestPermission(): Promise<{ granted: boolean }>
  update(options: PlaybackDetails): Promise<void>
  clear(): Promise<void>
  addListener(eventName: 'command', listener: (event: { command: string }) => void): Promise<PluginListenerHandle>
}

const PlaybackNotification = registerPlugin<PlaybackNotificationPlugin>('PlaybackNotification')

export async function requestPlaybackNotificationPermission() {
  if (Capacitor.getPlatform() !== 'android') return true
  try { return (await PlaybackNotification.requestPermission()).granted } catch { return false }
}

export async function updatePlaybackNotification(details: PlaybackDetails) {
  if (Capacitor.getPlatform() !== 'android') return
  try { await PlaybackNotification.update(details) } catch { /* Permission may be declined. */ }
}

export async function clearPlaybackNotification() {
  if (Capacitor.getPlatform() !== 'android') return
  try { await PlaybackNotification.clear() } catch { /* Native bridge is optional outside the APK. */ }
}

export async function listenForPlaybackCommands(listener: (command: string) => void) {
  if (Capacitor.getPlatform() !== 'android') return null
  try { return await PlaybackNotification.addListener('command', event => listener(event.command)) } catch { return null }
}
