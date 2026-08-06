'use client'
import { Capacitor, registerPlugin } from '@capacitor/core'
export type AppEdition = 'free' | 'pro'
interface AppEditionPlugin { getEdition(): Promise<{ edition: AppEdition }> }
const NativeEdition = registerPlugin<AppEditionPlugin>('AppEdition')
export async function getAppEdition(): Promise<AppEdition> {
  if (Capacitor.getPlatform() !== 'android') return 'free'
  try { return (await NativeEdition.getEdition()).edition === 'pro' ? 'pro' : 'free' } catch { return 'free' }
}
