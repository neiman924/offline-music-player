'use client'

import { Capacitor, registerPlugin } from '@capacitor/core'

export type NativeShazamStatus = {
  available: boolean
  configured: boolean
  platform: string
  sdkVersion?: string
  message?: string
}

export type NativeShazamMatch = {
  status: 'matched' | 'no-match'
  title?: string
  artist?: string
  shazamId?: string
  isrc?: string
  appleMusicId?: string
  artworkUrl?: string
  genres?: string[]
}

interface ShazamIdentifierPlugin {
  getStatus(): Promise<NativeShazamStatus>
  identify(options: { pcmBase64: string; sampleRate: 48_000 }): Promise<NativeShazamMatch>
}

const ShazamIdentifier = registerPlugin<ShazamIdentifierPlugin>('ShazamIdentifier')

export async function getNativeShazamStatus(): Promise<NativeShazamStatus> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return {
      available: false,
      configured: false,
      platform: Capacitor.getPlatform(),
      message: 'Shazam identification is available in the native Android APK.',
    }
  }

  try {
    return await ShazamIdentifier.getStatus()
  } catch (cause) {
    return {
      available: false,
      configured: false,
      platform: 'android',
      message: cause instanceof Error ? cause.message : 'The native Shazam bridge is unavailable.',
    }
  }
}

function uint8ToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

async function createShazamPcm(blob: Blob) {
  const AudioContextCtor = window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) throw new Error('This device cannot decode audio for identification.')

  const context = new AudioContextCtor()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    if (!Number.isFinite(decoded.duration) || decoded.duration < 3) {
      throw new Error('The track is too short to identify.')
    }

    const sampleRate = 48_000 as const
    const sampleSeconds = Math.min(12, decoded.duration)
    const startSeconds = decoded.duration > 42
      ? 30
      : Math.max(0, (decoded.duration - sampleSeconds) / 2)
    const frameCount = Math.max(1, Math.floor(sampleSeconds * sampleRate))
    const pcm = new Uint8Array(frameCount * 2)
    const view = new DataView(pcm.buffer)
    const channels = Array.from(
      { length: decoded.numberOfChannels },
      (_, index) => decoded.getChannelData(index),
    )

    for (let outputIndex = 0; outputIndex < frameCount; outputIndex += 1) {
      const sourcePosition = (startSeconds + outputIndex / sampleRate) * decoded.sampleRate
      const left = Math.min(Math.floor(sourcePosition), decoded.length - 1)
      const right = Math.min(left + 1, decoded.length - 1)
      const blend = sourcePosition - left
      let monoSample = 0
      for (const channel of channels) {
        monoSample += channel[left] + (channel[right] - channel[left]) * blend
      }
      monoSample = Math.max(-1, Math.min(1, monoSample / channels.length))
      const signed = monoSample < 0 ? monoSample * 0x8000 : monoSample * 0x7fff
      view.setInt16(outputIndex * 2, Math.round(signed), true)
    }

    return { pcmBase64: uint8ToBase64(pcm), sampleRate }
  } finally {
    await context.close().catch(() => undefined)
  }
}

export async function identifyLocalAudioWithShazam(blob: Blob) {
  const pcm = await createShazamPcm(blob)
  return ShazamIdentifier.identify(pcm)
}
