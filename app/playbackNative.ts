'use client'

import { Capacitor, registerPlugin } from '@capacitor/core'

type PlaybackDetails = { title: string; artist: string; album: string; playing: boolean }

interface PlaybackNotificationPlugin {
  update(options: PlaybackDetails): Promise<void>
  clear(): Promise<void>
}

const PlaybackNotification = registerPlugin<PlaybackNotificationPlugin>('PlaybackNotification')

export async function updatePlaybackNotification(details: PlaybackDetails) {
  if (Capacitor.getPlatform() !== 'android') return
  try { await PlaybackNotification.update(details) } catch { /* Notification permission may be declined. */ }
}

export async function clearPlaybackNotification() {
  if (Capacitor.getPlatform() !== 'android') return
  try { await PlaybackNotification.clear() } catch { /* Native bridge is optional outside the APK. */ }
}
