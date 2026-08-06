'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ChangeEvent, CSSProperties, FormEvent, ReactNode } from 'react'
import { clearPlaybackNotification, listenForPlaybackCommands, updatePlaybackNotification } from './playbackNative'
import { isNativeAndroid, pickLocalAudioFiles, pickLocalMusicFolder, playableDocumentUrl, type LocalDocument } from './localFolderNative'
import { lookupLyrics, lookupRadio } from './mobileServices'

// ─── Data ────────────────────────────────────────────────────────────────────

interface Track {
  id: number
  title: string
  artist: string
  album: string
  duration: number
  year: number
  genre: string
  cover: string
  artworkKey?: string
  sourceId?: string
  sourcePath?: string
  origin?: 'local' | 'synology' | 'radio'
  localKey?: string
  documentUri?: string
  radioUrl?: string
  radioHomepage?: string
  radioDistanceMiles?: number
  radioCodec?: string
  radioBitrate?: number
  radioTags?: string[]
  mood?: TrackMood
  moodConfidence?: number
  moodEnergy?: number
  moodTempo?: number
  moodAnalyzedAt?: string
  moodAnalysisError?: string
  moodModelVersion?: number
  moodLyricsUsed?: boolean
  originalTitle?: string
  originalArtist?: string
  metadataSource?: 'file' | 'filename' | 'lyrics' | 'manual'
  embeddedMetadataChecked?: boolean
}

interface Playlist {
  id: string
  name: string
  trackIds: number[]
}

const INITIAL_PLAYLISTS: Playlist[] = []

type TrackMood =
  | 'Calm'
  | 'Focus'
  | 'Happy'
  | 'Energetic'
  | 'Workout'
  | 'Balanced'
  | 'Romantic'
  | 'Sad'
  | 'Chill'
  | 'Dreamy'
  | 'Dark'
  | 'Party'
type View = 'local' | 'synology' | 'radio' | 'library' | 'albums' | 'moods' | 'favorites' | 'playlist' | 'nowplaying' | 'settings'
type NavView = Exclude<View, 'playlist'>
type PlaybackSource = 'local' | 'synology' | 'radio'
type PlayerTheme = 'apple-dark' | 'apple-light'
type PlayerAccent = 'pink' | 'red' | 'orange' | 'purple' | 'blue' | 'teal' | 'green'
type LightColorMode = 'random' | 'artwork'

interface PlayerSettings {
  theme: PlayerTheme
  accent: PlayerAccent
  density: 'compact' | 'comfortable'
  lightColorMode: LightColorMode
  preferLocal: boolean
  autoAnalyzeLocal: boolean
  updateMetadataFromLyrics: boolean
  navOrder: NavView[]
}

const DEFAULT_NAV_ORDER: NavView[] = ['local', 'synology', 'radio', 'favorites', 'moods', 'library', 'albums', 'nowplaying', 'settings']
const DEFAULT_SETTINGS: PlayerSettings = {
  theme: 'apple-dark',
  accent: 'pink',
  density: 'comfortable',
  lightColorMode: 'random',
  preferLocal: true,
  autoAnalyzeLocal: false,
  updateMetadataFromLyrics: false,
  navOrder: DEFAULT_NAV_ORDER,
}

// ─── NAS Types ───────────────────────────────────────────────────────────────

type NasType = 'synology' | 'qnap' | 'smb' | 'nfs'
type NasStatus = 'connected' | 'disconnected' | 'checking' | 'scanning' | 'error'
type ConnectionMode = 'local' | 'ddns' | 'quickconnect'

interface NasShare {
  path: string
  trackCount: number
  name?: string
}

interface NasDevice {
  id: string
  name: string
  type: NasType
  host: string
  port: string
  protocol: string
  username: string
  sharePath: string
  status: NasStatus
  lastSync: string | null
  shares: NasShare[]
  totalTracks: number
  remote: boolean
  remoteAddress?: string // QuickConnect ID, DDNS hostname, or public IP
  baseUrl?: string
  sid?: string
  connectionMode?: ConnectionMode
  quickConnectId?: string
  saved?: boolean
  connectionMessage?: string
  lastConnectionCheck?: string
}

interface DsmTarget {
  mode: ConnectionMode
  baseUrl: string
  host: string
  port: string
  quickConnectId: string
}

interface RadioStationResult {
  id: string
  name: string
  streamUrl: string
  homepage: string
  favicon: string
  tags: string[]
  state: string
  language: string
  codec: string
  bitrate: number
  hls: boolean
  distanceMiles: number
  popularity: number
}

interface RadioSearchResult {
  found: boolean
  zip?: string
  location?: string
  radiusMiles?: number
  stations?: RadioStationResult[]
  message?: string
  provider?: string
}

const NAS_PRESETS: Record<NasType, { label: string; defaultPort: string; protocol: string; icon: string }> = {
  synology: { label: 'Synology DiskStation', defaultPort: '5000', protocol: 'DSM API', icon: '🔵' },
  qnap: { label: 'QNAP NAS', defaultPort: '8080', protocol: 'QTS API', icon: '🟢' },
  smb: { label: 'SMB / Windows Share', defaultPort: '445', protocol: 'SMB', icon: '🔷' },
  nfs: { label: 'NFS Share', defaultPort: '2049', protocol: 'NFS', icon: '🔶' },
}

const INITIAL_DEVICES: NasDevice[] = []

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(s: number) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function fmtTrackDuration(s: number) {
  return Number.isFinite(s) && s > 0 ? fmt(s) : '—:—'
}

function cleanTrackTitle(value: string) {
  let title = value.split('/').filter(Boolean).at(-1) || value
  try { title = decodeURIComponent(title) } catch { /* Keep the original text when it is not URI encoded. */ }
  title = title
    .replace(/\.[A-Za-z0-9]{2,5}$/, '')
    .replace(/^_?[a-f0-9]{8,}_(?:\d{1,3}\.){3}\d{1,3}_\d+_?/i, '')
    .replace(/^\d+[ ._-]+/, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return title || 'Unknown track'
}

function lyricsSearchArtist(value: string) {
  const artist = value.trim()
  const placeholder = artist.toLocaleLowerCase()
  return ['local music', 'local file', 'local files', 'unknown artist', 'on this device'].includes(placeholder)
    ? ''
    : artist
}

function totalTime(tracks: Track[]) {
  const s = tracks.reduce((a, t) => a + t.duration, 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function readSessionStored<T>(key: string, fallback: T): T {
  try {
    const value = sessionStorage.getItem(key)
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

const LOCAL_DB_NAME = 'tunestack-local-audio'
const LOCAL_STORE_NAME = 'tracks'
const ARTWORK_STORE_NAME = 'artwork'
const MOOD_MODEL_VERSION = 2

interface LocalTrackRecord {
  key: string
  blob: Blob
  track: Track
  savedAt: string
}

interface TrackArtworkRecord {
  key: string
  blob: Blob
  savedAt: string
}

function trackLocalKey(track: Track) {
  return track.localKey || `${track.sourceId || 'unknown'}:${track.sourcePath || track.id}`
}

function stableNumericId(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return -(Math.abs(hash) || 1)
}

function radioTrack(station: RadioStationResult, location: string): Track {
  const tags = station.tags.length ? station.tags : ['Live radio']
  return {
    id: stableNumericId(`radio:${station.id}`),
    title: station.name,
    artist: `Live radio · ${location}`,
    album: station.name,
    duration: 0,
    year: 0,
    genre: tags[0],
    cover: station.favicon,
    sourceId: 'radio-browser',
    sourcePath: station.id,
    origin: 'radio',
    localKey: `radio:${station.id}`,
    radioUrl: station.streamUrl,
    radioHomepage: station.homepage,
    radioDistanceMiles: station.distanceMiles,
    radioCodec: station.codec,
    radioBitrate: station.bitrate,
    radioTags: tags,
    metadataSource: 'file',
  }
}

function openLocalAudioDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(LOCAL_STORE_NAME)) db.createObjectStore(LOCAL_STORE_NAME, { keyPath: 'key' })
      if (!db.objectStoreNames.contains(ARTWORK_STORE_NAME)) db.createObjectStore(ARTWORK_STORE_NAME, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Local audio storage could not be opened.'))
  })
}

async function readLocalAudio(track: Track) {
  const db = await openLocalAudioDb()
  return new Promise<LocalTrackRecord | null>((resolve, reject) => {
    const request = db.transaction(LOCAL_STORE_NAME, 'readonly').objectStore(LOCAL_STORE_NAME).get(trackLocalKey(track))
    request.onsuccess = () => resolve((request.result as LocalTrackRecord | undefined) ?? null)
    request.onerror = () => reject(request.error || new Error('The local copy could not be read.'))
  })
}

async function saveLocalAudio(track: Track, blob: Blob) {
  const db = await openLocalAudioDb()
  const record: LocalTrackRecord = { key: trackLocalKey(track), blob, track, savedAt: new Date().toISOString() }
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(LOCAL_STORE_NAME, 'readwrite').objectStore(LOCAL_STORE_NAME).put(record)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('The audio file could not be saved locally.'))
  })
}

async function listLocalAudioKeys() {
  const db = await openLocalAudioDb()
  return new Promise<string[]>((resolve, reject) => {
    const request = db.transaction(LOCAL_STORE_NAME, 'readonly').objectStore(LOCAL_STORE_NAME).getAllKeys()
    request.onsuccess = () => resolve(request.result.map(String))
    request.onerror = () => reject(request.error || new Error('Local audio storage could not be read.'))
  })
}

async function saveTrackArtwork(track: Track, blob: Blob) {
  const db = await openLocalAudioDb()
  const record: TrackArtworkRecord = { key: trackLocalKey(track), blob, savedAt: new Date().toISOString() }
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(ARTWORK_STORE_NAME, 'readwrite').objectStore(ARTWORK_STORE_NAME).put(record)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('Album artwork could not be saved.'))
  })
}

async function listTrackArtwork() {
  const db = await openLocalAudioDb()
  return new Promise<TrackArtworkRecord[]>((resolve, reject) => {
    const request = db.transaction(ARTWORK_STORE_NAME, 'readonly').objectStore(ARTWORK_STORE_NAME).getAll()
    request.onsuccess = () => resolve(request.result as TrackArtworkRecord[])
    request.onerror = () => reject(request.error || new Error('Saved album artwork could not be read.'))
  })
}

type MoodAnalysisState = {
  status: 'idle' | 'running' | 'done' | 'error'
  completed: number
  total: number
  skipped: number
  message: string
}

type DeviceClass = 'phone' | 'tablet' | 'desktop'

type DeviceProfile = {
  ready: boolean
  deviceClass: DeviceClass
  browser: string
  browserSlug: string
  os: string
  appMode: 'Installed app' | 'Browser tab'
  maxAudioBytes: number
  maxAudioSeconds: number
  memoryGb: number | null
}

const DEFAULT_DEVICE_PROFILE: DeviceProfile = {
  ready: false,
  deviceClass: 'desktop',
  browser: 'Browser',
  browserSlug: 'other',
  os: 'Unknown platform',
  appMode: 'Browser tab',
  maxAudioBytes: 80 * 1024 * 1024,
  maxAudioSeconds: 15 * 60,
  memoryGb: null,
}

function detectDeviceProfile(): DeviceProfile {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return DEFAULT_DEVICE_PROFILE
  const ua = navigator.userAgent || ''
  const platform = navigator.platform || ''
  const touchPoints = navigator.maxTouchPoints || 0
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const shortestScreenSide = Math.min(window.screen?.width || window.innerWidth, window.screen?.height || window.innerHeight)
  const isIPad = /iPad/i.test(ua) || (platform === 'MacIntel' && touchPoints > 1)
  const isAndroidTablet = /Android/i.test(ua) && !/Mobile/i.test(ua)
  const isTablet = isIPad || isAndroidTablet || /Tablet|Silk|PlayBook/i.test(ua) || (coarsePointer && shortestScreenSide >= 600 && shortestScreenSide <= 1280)
  const isPhone = !isTablet && (/iPhone|iPod|Android.*Mobile|Mobi/i.test(ua) || (coarsePointer && shortestScreenSide < 600))
  const deviceClass: DeviceClass = isPhone ? 'phone' : isTablet ? 'tablet' : 'desktop'

  let browser = 'Browser'
  let browserSlug = 'other'
  if (/SamsungBrowser/i.test(ua)) { browser = 'Samsung Internet'; browserSlug = 'samsung' }
  else if (/EdgA|EdgiOS|Edg\//i.test(ua)) { browser = 'Microsoft Edge'; browserSlug = 'edge' }
  else if (/OPR|Opera/i.test(ua)) { browser = 'Opera'; browserSlug = 'opera' }
  else if (/CriOS|Chrome/i.test(ua)) { browser = 'Chrome'; browserSlug = 'chrome' }
  else if (/FxiOS|Firefox/i.test(ua)) { browser = 'Firefox'; browserSlug = 'firefox' }
  else if (/Safari/i.test(ua)) { browser = 'Safari'; browserSlug = 'safari' }

  let os = 'Unknown platform'
  if (/Android/i.test(ua)) os = 'Android'
  else if (/iPhone|iPad|iPod/i.test(ua) || isIPad) os = 'iOS / iPadOS'
  else if (/Windows/i.test(ua)) os = 'Windows'
  else if (/CrOS/i.test(ua)) os = 'ChromeOS'
  else if (/Mac OS|Macintosh/i.test(ua)) os = 'macOS'
  else if (/Linux/i.test(ua)) os = 'Linux'

  const reportedMemory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory)
  const memoryGb = Number.isFinite(reportedMemory) && reportedMemory > 0 ? reportedMemory : null
  const appMode = window.matchMedia?.('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone) ? 'Installed app' : 'Browser tab'
  const lowMemory = memoryGb !== null && memoryGb <= 4
  const maxAudioBytes = deviceClass === 'phone' ? (lowMemory ? 18 : 28) * 1024 * 1024 : deviceClass === 'tablet' ? (lowMemory ? 32 : 50) * 1024 * 1024 : 100 * 1024 * 1024
  const maxAudioSeconds = deviceClass === 'phone' ? 8 * 60 : deviceClass === 'tablet' ? 12 * 60 : 20 * 60

  return { ready: true, deviceClass, browser, browserSlug, os, appMode, maxAudioBytes, maxAudioSeconds, memoryGb }
}

function useDeviceProfile() {
  const [profile, setProfile] = useState<DeviceProfile>(DEFAULT_DEVICE_PROFILE)
  useEffect(() => {
    const update = () => setProfile(detectDeviceProfile())
    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])
  return profile
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

function synchsafeInteger(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] & 0x7f) << 21)
    | ((bytes[offset + 1] & 0x7f) << 14)
    | ((bytes[offset + 2] & 0x7f) << 7)
    | (bytes[offset + 3] & 0x7f)
}

function unsignedInteger(bytes: Uint8Array, offset: number, length: number) {
  let value = 0
  for (let index = 0; index < length; index += 1) value = value * 256 + (bytes[offset + index] || 0)
  return value
}

function littleEndianInteger(bytes: Uint8Array, offset: number, length = 4) {
  let value = 0
  for (let index = length - 1; index >= 0; index -= 1) value = value * 256 + (bytes[offset + index] || 0)
  return value
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return Array.from(bytes.subarray(start, end), value => String.fromCharCode(value)).join('')
}

interface EmbeddedTrackMetadata {
  title?: string
  artist?: string
  album?: string
  genre?: string
  year?: number
}

function cleanEmbeddedText(value: string) {
  return value.replace(/\u0000/g, '').trim()
}

function decodeId3Text(payload: Uint8Array) {
  if (payload.length < 2) return ''
  const encoding = payload[0]
  const text = payload.subarray(1)
  try {
    if (encoding === 0) return cleanEmbeddedText(new TextDecoder('windows-1252').decode(text))
    if (encoding === 3) return cleanEmbeddedText(new TextDecoder('utf-8').decode(text))
    if (encoding === 2) return cleanEmbeddedText(new TextDecoder('utf-16be').decode(text))
    if (text[0] === 0xfe && text[1] === 0xff) return cleanEmbeddedText(new TextDecoder('utf-16be').decode(text.subarray(2)))
    if (text[0] === 0xff && text[1] === 0xfe) return cleanEmbeddedText(new TextDecoder('utf-16le').decode(text.subarray(2)))
    return cleanEmbeddedText(new TextDecoder('utf-16le').decode(text))
  } catch {
    return ''
  }
}

function parseId3Metadata(bytes: Uint8Array): EmbeddedTrackMetadata | null {
  if (ascii(bytes, 0, 3) !== 'ID3' || bytes.length < 10) return null
  const version = bytes[3]
  const tagEnd = Math.min(bytes.length, 10 + synchsafeInteger(bytes, 6))
  const metadata: EmbeddedTrackMetadata = {}
  let offset = 10
  while (offset + 10 <= tagEnd) {
    const id = ascii(bytes, offset, offset + 4)
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const size = version === 4 ? synchsafeInteger(bytes, offset + 4) : unsignedInteger(bytes, offset + 4, 4)
    const payloadStart = offset + 10
    const payloadEnd = Math.min(tagEnd, payloadStart + size)
    if (id[0] === 'T' && id !== 'TXXX' && payloadEnd > payloadStart) {
      const value = decodeId3Text(bytes.subarray(payloadStart, payloadEnd))
      if (id === 'TIT2' && value) metadata.title = value
      if (id === 'TPE1' && value) metadata.artist = value
      if (id === 'TALB' && value) metadata.album = value
      if (id === 'TCON' && value) metadata.genre = value.replace(/^\((\d+)\)$/, '$1')
      if ((id === 'TDRC' || id === 'TYER') && value) {
        const year = Number(value.match(/\d{4}/)?.[0] || 0)
        if (year > 1800 && year < 2200) metadata.year = year
      }
    }
    if (!size) break
    offset = payloadEnd
  }
  return Object.keys(metadata).length ? metadata : null
}

function parseFlacMetadata(bytes: Uint8Array): EmbeddedTrackMetadata | null {
  if (ascii(bytes, 0, 4) !== 'fLaC') return null
  let offset = 4
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset]
    const isLast = Boolean(header & 0x80)
    const type = header & 0x7f
    const size = unsignedInteger(bytes, offset + 1, 3)
    const payloadStart = offset + 4
    const payloadEnd = payloadStart + size
    if (payloadEnd > bytes.length) break
    if (type === 4 && size > 8) {
      const metadata: EmbeddedTrackMetadata = {}
      let cursor = payloadStart
      const vendorLength = littleEndianInteger(bytes, cursor)
      cursor += 4 + vendorLength
      const commentCount = littleEndianInteger(bytes, cursor)
      cursor += 4
      for (let index = 0; index < Math.min(commentCount, 256) && cursor + 4 <= payloadEnd; index += 1) {
        const length = littleEndianInteger(bytes, cursor)
        cursor += 4
        if (cursor + length > payloadEnd) break
        const comment = new TextDecoder('utf-8').decode(bytes.subarray(cursor, cursor + length))
        cursor += length
        const separator = comment.indexOf('=')
        if (separator < 1) continue
        const key = comment.slice(0, separator).toLocaleUpperCase()
        const value = cleanEmbeddedText(comment.slice(separator + 1))
        if (key === 'TITLE' && value) metadata.title = value
        if (key === 'ARTIST' && value) metadata.artist = value
        if (key === 'ALBUM' && value) metadata.album = value
        if (key === 'GENRE' && value) metadata.genre = value
        if ((key === 'DATE' || key === 'YEAR') && value) {
          const year = Number(value.match(/\d{4}/)?.[0] || 0)
          if (year > 1800 && year < 2200) metadata.year = year
        }
      }
      return Object.keys(metadata).length ? metadata : null
    }
    offset = payloadEnd
    if (isLast) break
  }
  return null
}

async function extractEmbeddedTrackMetadata(blob: Blob) {
  const scanSize = Math.min(blob.size, 4 * 1024 * 1024)
  const bytes = new Uint8Array(await blob.slice(0, scanSize).arrayBuffer())
  return parseId3Metadata(bytes) || parseFlacMetadata(bytes)
}

function imageMime(bytes: Uint8Array, fallback = 'image/jpeg') {
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (ascii(bytes, 0, 4) === 'GIF8') return 'image/gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  return fallback.startsWith('image/') ? fallback : 'image/jpeg'
}

function findTextTerminator(bytes: Uint8Array, start: number, twoByte: boolean) {
  for (let index = start; index < bytes.length - (twoByte ? 1 : 0); index += twoByte ? 2 : 1) {
    if (bytes[index] === 0 && (!twoByte || bytes[index + 1] === 0)) return index
  }
  return bytes.length
}

function parseId3Artwork(bytes: Uint8Array) {
  if (ascii(bytes, 0, 3) !== 'ID3' || bytes.length < 10) return null
  const version = bytes[3]
  const tagEnd = Math.min(bytes.length, 10 + synchsafeInteger(bytes, 6))
  let offset = 10
  while (offset + 10 <= tagEnd) {
    const id = ascii(bytes, offset, offset + 4)
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const size = version === 4 ? synchsafeInteger(bytes, offset + 4) : unsignedInteger(bytes, offset + 4, 4)
    const payloadStart = offset + 10
    const payloadEnd = Math.min(tagEnd, payloadStart + size)
    if (id === 'APIC' && payloadEnd > payloadStart + 8) {
      const payload = bytes.subarray(payloadStart, payloadEnd)
      const encoding = payload[0]
      const mimeEnd = findTextTerminator(payload, 1, false)
      const mime = ascii(payload, 1, mimeEnd) || 'image/jpeg'
      const descriptionStart = Math.min(payload.length, mimeEnd + 2)
      const doubleByte = encoding === 1 || encoding === 2
      const descriptionEnd = findTextTerminator(payload, descriptionStart, doubleByte)
      const imageStart = Math.min(payload.length, descriptionEnd + (doubleByte ? 2 : 1))
      const imageBytes = payload.subarray(imageStart)
      if (imageBytes.length > 64) return new Blob([new Uint8Array(imageBytes).buffer as ArrayBuffer], { type: imageMime(imageBytes, mime) })
    }
    if (!size) break
    offset = payloadEnd
  }
  return null
}

function parseFlacArtwork(bytes: Uint8Array) {
  if (ascii(bytes, 0, 4) !== 'fLaC') return null
  let offset = 4
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset]
    const isLast = Boolean(header & 0x80)
    const type = header & 0x7f
    const size = unsignedInteger(bytes, offset + 1, 3)
    const payloadStart = offset + 4
    const payloadEnd = payloadStart + size
    if (payloadEnd > bytes.length) break
    if (type === 6 && size > 32) {
      let cursor = payloadStart + 4
      const mimeLength = unsignedInteger(bytes, cursor, 4)
      cursor += 4
      const mime = ascii(bytes, cursor, cursor + mimeLength)
      cursor += mimeLength
      const descriptionLength = unsignedInteger(bytes, cursor, 4)
      cursor += 4 + descriptionLength + 16
      const imageLength = unsignedInteger(bytes, cursor, 4)
      cursor += 4
      const imageBytes = bytes.subarray(cursor, Math.min(payloadEnd, cursor + imageLength))
      if (imageBytes.length > 64) return new Blob([new Uint8Array(imageBytes).buffer as ArrayBuffer], { type: imageMime(imageBytes, mime) })
    }
    offset = payloadEnd
    if (isLast) break
  }
  return null
}

async function extractEmbeddedArtwork(blob: Blob) {
  const scanSize = Math.min(blob.size, 12 * 1024 * 1024)
  const bytes = new Uint8Array(await blob.slice(0, scanSize).arrayBuffer())
  return parseId3Artwork(bytes) || parseFlacArtwork(bytes)
}

async function normalizeArtworkBlob(blob: Blob) {
  if (!blob.type.startsWith('image/')) return null
  try {
    const bitmap = await createImageBitmap(blob)
    const maxSide = 512
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close()
      return blob
    }
    context.fillStyle = '#111114'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .84))
  } catch {
    return blob.size <= 1_500_000 ? blob : null
  }
}

function keywordScore(text: string, keywords: string[]) {
  if (!text) return 0
  const normalized = text.toLocaleLowerCase()
  let matches = 0
  for (const keyword of keywords) {
    let cursor = 0
    while ((cursor = normalized.indexOf(keyword, cursor)) >= 0) {
      matches += 1
      cursor += keyword.length
      if (matches >= 8) return 1
    }
  }
  return clamp(matches / 5)
}

function lyricMoodSignals(lyrics: string) {
  return {
    positive: keywordScore(lyrics, ['happy', 'joy', 'smile', 'sunshine', 'celebrate', 'hope', 'شاد', 'خوش', 'لبخند', 'امید', 'بهار']),
    sad: keywordScore(lyrics, ['sad', 'cry', 'tears', 'lonely', 'broken', 'goodbye', 'pain', 'lost', 'غم', 'گریه', 'تنها', 'درد', 'خداحافظ', 'شکست']),
    love: keywordScore(lyrics, ['love', 'heart', 'kiss', 'darling', 'forever', 'together', 'baby', 'عشق', 'دوستت', 'قلب', 'بوسه', 'یار', 'جانم']),
    calm: keywordScore(lyrics, ['calm', 'sleep', 'dream', 'moon', 'night', 'breathe', 'peace', 'آرام', 'خواب', 'رویا', 'شب', 'ماه']),
    dark: keywordScore(lyrics, ['dark', 'death', 'fear', 'hate', 'blood', 'war', 'fire', 'خشم', 'نفرت', 'جنگ', 'مرگ', 'آتش']),
    party: keywordScore(lyrics, ['dance', 'party', 'club', 'tonight', 'move', 'rhythm', 'رقص', 'برقص', 'مهمانی', 'جشن']),
  }
}

function lyricsTextFromPayload(payload: { found?: boolean; instrumental?: boolean; plainLyrics?: string | null; syncedLyrics?: string | null }) {
  if (!payload.found || payload.instrumental) return ''
  return (payload.plainLyrics || payload.syncedLyrics || '').replace(/\[[0-9:.]+\]/g, ' ').slice(0, 24_000)
}

async function fetchLyricsForMood(track: Track, duration: number, signal: AbortSignal) {
  try {
    if (signal.aborted) return ''
    return lyricsTextFromPayload(await lookupLyrics({ title: track.title, artist: track.artist, album: track.album, duration: Math.round(duration || track.duration || 0) }))
  } catch {
    return ''
  }
}

async function analyzeAudioMood(context: AudioContext, blob: Blob, lyrics = '') {
  let encoded: ArrayBuffer | null = await blob.arrayBuffer()
  const buffer = await context.decodeAudioData(encoded)
  encoded = null
  const sampleRate = buffer.sampleRate
  const channelCount = Math.min(buffer.numberOfChannels, 2)
  const channels = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index))
  const durationSeconds = buffer.duration
  const segmentSeconds = Math.min(32, Math.max(12, durationSeconds / 3))
  const starts = durationSeconds <= 42
    ? [0]
    : [durationSeconds * .06, durationSeconds * .39, durationSeconds * .70]
  const segmentResults: Array<{ energy: number; brightness: number; tempo: number }> = []

  for (const startSeconds of starts) {
    const start = Math.min(buffer.length - 1, Math.floor(startSeconds * sampleRate))
    const end = Math.min(buffer.length, start + Math.floor(segmentSeconds * sampleRate))
    const length = Math.max(0, end - start)
    const stride = Math.max(1, Math.floor(length / 38_000))
    const envelopeWindow = Math.max(1, Math.floor(sampleRate * .05 / stride))
    const envelope: number[] = []
    let squares = 0
    let crossings = 0
    let samples = 0
    let previous = 0
    let envelopeSum = 0
    let envelopeSamples = 0

    for (let index = start; index < end; index += stride) {
      let value = 0
      for (const channel of channels) value += channel[index] || 0
      value /= channelCount
      squares += value * value
      if (samples > 0 && ((value >= 0) !== (previous >= 0))) crossings += 1
      previous = value
      envelopeSum += Math.abs(value)
      envelopeSamples += 1
      samples += 1
      if (envelopeSamples >= envelopeWindow) {
        envelope.push(envelopeSum / envelopeSamples)
        envelopeSum = 0
        envelopeSamples = 0
      }
    }

    if (!samples || envelope.length < 3) continue
    const rms = Math.sqrt(squares / samples)
    const energy = clamp(rms * 5.4)
    const brightness = clamp((crossings / samples) * 19)
    const averageEnvelope = envelope.reduce((sum, value) => sum + value, 0) / envelope.length
    const peakThreshold = averageEnvelope * 1.42
    const minimumPeakGap = 5
    let peaks = 0
    let lastPeak = -minimumPeakGap
    for (let index = 1; index < envelope.length - 1; index += 1) {
      if (envelope[index] > peakThreshold && envelope[index] > envelope[index - 1] && envelope[index] >= envelope[index + 1] && index - lastPeak >= minimumPeakGap) {
        peaks += 1
        lastPeak = index
      }
    }
    let tempo = peaks > 2 ? peaks / ((length / sampleRate) / 60) : 0
    while (tempo > 0 && tempo < 65) tempo *= 2
    while (tempo > 180) tempo /= 2
    segmentResults.push({ energy, brightness, tempo })
  }

  if (!segmentResults.length) throw new Error('This audio file did not contain enough decodable sound.')
  const average = (key: 'energy' | 'brightness') => segmentResults.reduce((sum, item) => sum + item[key], 0) / segmentResults.length
  const energy = average('energy')
  const brightness = average('brightness')
  const tempoValues = segmentResults.map(item => item.tempo).filter(Boolean).sort((first, second) => first - second)
  const tempo = Math.round(tempoValues[Math.floor(tempoValues.length / 2)] || 0)
  const energySpread = Math.max(...segmentResults.map(item => item.energy)) - Math.min(...segmentResults.map(item => item.energy))
  const lyricSignals = lyricMoodSignals(lyrics)
  const slow = tempo ? clamp((105 - tempo) / 45) : .45
  const fast = tempo ? clamp((tempo - 92) / 55) : 0
  const smooth = 1 - clamp(energySpread * 2.4)

  const scores: Record<TrackMood, number> = {
    Calm: (1 - energy) * 1.35 + slow * .75 + smooth * .35 + lyricSignals.calm * 1.1,
    Focus: (1 - Math.abs(energy - .34)) * .65 + slow * .35 + smooth * .7,
    Happy: brightness * .65 + energy * .45 + lyricSignals.positive * 1.55 - lyricSignals.sad * .4,
    Energetic: energy * 1.2 + fast * .95 + brightness * .2,
    Workout: energy * 1.4 + fast * 1.15 - lyricSignals.calm * .25,
    Balanced: .78 + (1 - Math.abs(energy - .5)) * .35 + smooth * .2,
    Romantic: lyricSignals.love * 1.8 + (1 - Math.abs(energy - .42)) * .5 + slow * .25,
    Sad: lyricSignals.sad * 1.75 + (1 - energy) * .55 + (1 - brightness) * .45,
    Chill: (1 - Math.abs(energy - .34)) * .75 + slow * .45 + smooth * .55,
    Dreamy: (1 - brightness) * .55 + smooth * .65 + lyricSignals.calm * .65 + lyricSignals.love * .3,
    Dark: lyricSignals.dark * 1.5 + lyricSignals.sad * .65 + (1 - brightness) * .65 + energy * .25,
    Party: lyricSignals.party * 1.55 + energy * 1.05 + fast * .85 + lyricSignals.positive * .35,
  }
  const ranked = (Object.entries(scores) as Array<[TrackMood, number]>).sort((first, second) => second[1] - first[1])
  const mood = ranked[0][0]
  const separation = ranked[0][1] - ranked[1][1]
  const confidence = Math.round(clamp(.57 + separation * .17 + (lyrics ? .07 : 0), .57, .94) * 100)
  return { mood, confidence, energy: Math.round(energy * 100), tempo, lyricsUsed: Boolean(lyrics) }
}

async function readAudioDuration(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const audio = document.createElement('audio')
  audio.preload = 'metadata'
  return new Promise<number | null>(resolve => {
    let settled = false
    const finish = (duration: number | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(url)
      resolve(duration)
    }
    const timer = window.setTimeout(() => finish(null), 6000)
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : null)
    audio.onerror = () => finish(null)
    audio.src = url
  })
}

type DsmFile = { name: string; path: string; isdir: boolean }
type SynologyFolderChoice = DsmFile & { parentPath: string | null; depth: number; trackCount: number }

const AUDIO_EXTENSIONS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'aiff', 'wma'])

function stableTrackId(path: string) {
  let hash = 0
  for (let i = 0; i < path.length; i += 1) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0
  return Math.abs(hash) || 1
}

function dsmErrorMessage(code: number | undefined, api = '') {
  if (api === 'SYNO.API.Auth') {
    const authMessages: Record<number, string> = {
      400: 'The DSM username or password is incorrect.',
      401: 'This DSM account is disabled.',
      402: 'DSM denied File Station application access for this account.',
      403: 'Two-factor authentication is required.',
      404: 'Two-factor authentication failed.',
      406: 'This DSM account is locked. Try again later.',
    }
    if (code !== undefined && authMessages[code]) return authMessages[code]
  }
  const commonMessages: Record<number, string> = {
    100: 'DSM returned an unknown API error.',
    101: 'Required DSM API details are missing.',
    102: 'This DSM does not provide the requested API.',
    103: 'This DSM does not provide the requested API method.',
    104: 'This DSM API version is not supported.',
    105: 'The DSM session does not have permission for this operation.',
    106: 'The DSM session timed out. Connect again.',
    107: 'The DSM session was interrupted by another login. Connect again.',
    119: 'DSM could not find the saved session. Connect again.',
  }
  if (code !== undefined && commonMessages[code]) return commonMessages[code]
  if (api.startsWith('SYNO.FileStation.')) {
    const fileMessages: Record<number, string> = {
      400: 'DSM rejected the File Station request parameters.',
      402: 'File Station is busy. Try again in a moment.',
      403: 'File Station rejected this user for the requested operation.',
      407: 'File Station does not permit this operation for the current account.',
      408: 'The selected DSM file or folder no longer exists.',
      411: 'The selected DSM folder is read-only.',
    }
    if (code !== undefined && fileMessages[code]) return fileMessages[code]
  }
  return `DSM returned error ${code ?? 'unknown'} for ${api || 'this request'}.`
}

class DsmApiError extends Error {
  code?: number
  api: string

  constructor(message: string, code?: number, api = '') {
    super(message)
    this.name = 'DsmApiError'
    this.code = code
    this.api = api
  }
}

async function dsmCall<T>(target: DsmTarget, params: Record<string, string>, method: 'GET' | 'POST' = 'GET') {
  let response: Response
  if (target.mode === 'local') {
    const url = new URL('/webapi/entry.cgi', target.baseUrl)
    const body = new URLSearchParams(params)
    if (method === 'GET') Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
    response = await fetch(url, {
      method, credentials: 'omit',
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body } : {}),
    })
  } else {
    response = await fetch('/api/synology', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: target.mode,
        host: target.host,
        port: target.port,
        quickConnectId: target.quickConnectId,
        params,
      }),
    })
  }
  const payload = await response.json() as { success: boolean; data?: T; error?: { code?: number; message?: string } }
  const api = params.api || ''
  if (!response.ok) throw new DsmApiError(payload.error?.message || `DSM connection failed with HTTP ${response.status}.`, payload.error?.code, api)
  if (!payload.success) throw new DsmApiError(payload.error?.message || dsmErrorMessage(payload.error?.code, api), payload.error?.code, api)
  return payload.data as T
}

function withConnectionTimeout<T>(request: Promise<T>, timeoutMs = 10_000) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('The Synology connection check timed out. Tap Reconnect to sign in again.')), timeoutMs)
    request.then(
      result => {
        window.clearTimeout(timer)
        resolve(result)
      },
      cause => {
        window.clearTimeout(timer)
        reject(cause)
      },
    )
  })
}

async function connectToSynology(target: DsmTarget, account: string, password: string, otpCode = '') {
  const loginParams = (version: string): Record<string, string> => ({
    api: 'SYNO.API.Auth', version, method: 'login', account, passwd: password,
    session: 'FileStation', format: 'sid',
  })
  const currentLogin = loginParams('7')
  if (otpCode.trim()) currentLogin.otp_code = otpCode.trim()
  let auth: { sid: string }
  try {
    auth = await dsmCall<{ sid: string }>(target, currentLogin, 'POST')
  } catch (cause) {
    if (!(cause instanceof DsmApiError) || cause.code !== 104) throw cause
    const compatibleLogin = loginParams('3')
    if (otpCode.trim()) compatibleLogin.otp_code = otpCode.trim()
    auth = await dsmCall<{ sid: string }>(target, compatibleLogin, 'POST')
  }
  let data: { shares: DsmFile[] }
  try {
    data = await dsmCall<{ shares: DsmFile[] }>(target, {
      api: 'SYNO.FileStation.List', version: '2', method: 'list_share', _sid: auth.sid,
    })
  } catch (cause) {
    if (!(cause instanceof DsmApiError) || cause.code !== 104) throw cause
    data = await dsmCall<{ shares: DsmFile[] }>(target, {
      api: 'SYNO.FileStation.List', version: '1', method: 'list_share', _sid: auth.sid,
    })
  }
  return { sid: auth.sid, shares: data.shares ?? [] }
}

async function listSynologySubfolders(target: DsmTarget, sid: string, folderPath: string) {
  const folders: DsmFile[] = []
  let offset = 0
  let total = 0
  do {
    const data = await dsmCall<{ files: DsmFile[]; total: number }>(target, {
      api: 'SYNO.FileStation.List', version: '2', method: 'list', folder_path: folderPath,
      offset: String(offset), limit: '500', _sid: sid,
    })
    const files = data.files ?? []
    total = data.total ?? files.length
    folders.push(...files.filter(file => file.isdir))
    offset += files.length
  } while (offset < total)
  return folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

function parentFolderPath(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : null
}

function folderDepth(path: string) {
  return Math.max(0, path.split('/').filter(Boolean).length - 1)
}

async function discoverSynologyFolders(target: DsmTarget, sid: string, rootShares: DsmFile[], onProgress: (folders: number, tracks: number) => void) {
  type FolderIndex = {
    name: string
    path: string
    parentPath: string | null
    depth: number
    directTracks: number
  }

  const tracks = new Map<string, Track>()
  const folderIndex = new Map<string, FolderIndex>()
  let foldersProcessed = 0

  for (const share of rootShares) {
    const queue = [{ folder: share, parentPath: null as string | null, depth: 0 }]
    while (queue.length) {
      const current = queue.shift()!
      const folderPath = current.folder.path
      const entry: FolderIndex = {
        name: current.folder.name,
        path: folderPath,
        parentPath: current.parentPath,
        depth: current.depth,
        directTracks: 0,
      }
      folderIndex.set(folderPath, entry)
      let offset = 0
      let total = 0
      do {
        const data = await dsmCall<{ files: DsmFile[]; total: number }>(target, {
          api: 'SYNO.FileStation.List', version: '2', method: 'list', folder_path: folderPath,
          offset: String(offset), limit: '500', _sid: sid,
        })
        const files = data.files ?? []
        total = data.total ?? files.length
        for (const file of files) {
          if (file.isdir) {
            queue.push({ folder: file, parentPath: folderPath, depth: current.depth + 1 })
            continue
          }
          const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
          if (!AUDIO_EXTENSIONS.has(extension)) continue
          const parts = file.path.split('/').filter(Boolean)
          const title = cleanTrackTitle(file.name)
          tracks.set(file.path, {
            id: stableTrackId(file.path), title, artist: parts.at(-3) ?? 'Unknown artist',
            album: parts.at(-2) ?? share.name, duration: 0, year: 0, genre: 'Uncategorized',
            cover: '/icon-512.png', sourcePath: file.path,
          })
          entry.directTracks += 1
        }
        offset += files.length
        onProgress(foldersProcessed, tracks.size)
      } while (offset < total)
      foldersProcessed += 1
      onProgress(foldersProcessed, tracks.size)
    }
  }

  const totals = new Map(Array.from(folderIndex.values()).map(folder => [folder.path, folder.directTracks]))
  const deepestFirst = Array.from(folderIndex.values()).sort((a, b) => b.depth - a.depth)
  for (const folder of deepestFirst) {
    if (!folder.parentPath) continue
    totals.set(folder.parentPath, (totals.get(folder.parentPath) ?? 0) + (totals.get(folder.path) ?? 0))
  }

  const folders: SynologyFolderChoice[] = Array.from(folderIndex.values())
    .map(folder => ({
      name: folder.name,
      path: folder.path,
      isdir: true,
      parentPath: folder.parentPath,
      depth: folder.depth,
      trackCount: totals.get(folder.path) ?? 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))

  return { folders, tracks: Array.from(tracks.values()) }
}

function pathIncludesFolder(filePath: string, folderPath: string) {
  return filePath.startsWith(`${folderPath.replace(/\/$/, '')}/`)
}

function foldersOverlap(first: string, second: string) {
  return first === second || pathIncludesFolder(first, second) || pathIncludesFolder(second, first)
}

function targetForDevice(device: NasDevice): DsmTarget {
  const mode = device.connectionMode ?? (device.remote ? 'ddns' : 'local')
  const secure = device.baseUrl?.startsWith('http://') ? false : true
  const baseUrl = device.baseUrl || `${secure ? 'https' : 'http'}://${device.host}${device.port ? `:${device.port}` : ''}`
  return {
    mode,
    baseUrl,
    host: device.host,
    port: device.port || '5001',
    quickConnectId: device.quickConnectId || '',
  }
}

async function checkSynologyDevice(device: NasDevice): Promise<Pick<NasDevice, 'status' | 'sid' | 'connectionMessage' | 'lastConnectionCheck'>> {
  const target = targetForDevice(device)
  const checkedAt = new Date().toISOString()

  if (device.sid) {
    try {
      await withConnectionTimeout(dsmCall<{ shares: DsmFile[] }>(target, {
        api: 'SYNO.FileStation.List',
        version: '2',
        method: 'list_share',
        _sid: device.sid,
      }))
      return {
        status: 'connected',
        sid: device.sid,
        connectionMessage: 'DSM session is active and File Station is ready.',
        lastConnectionCheck: checkedAt,
      }
    } catch {
      // A saved in-app session can expire. Confirm that DSM itself is reachable
      // before asking the user to sign in again.
    }
  }

  try {
    await withConnectionTimeout(dsmCall<Record<string, unknown>>(target, {
      api: 'SYNO.API.Info',
      version: '1',
      method: 'query',
      query: 'SYNO.API.Auth',
    }))
    return {
      status: 'disconnected',
      sid: undefined,
      connectionMessage: device.sid
        ? 'The NAS is online, but the DSM session expired. Reconnect to continue.'
        : 'The NAS is online. Sign in once to reconnect this saved source.',
      lastConnectionCheck: checkedAt,
    }
  } catch (cause) {
    return {
      status: 'error',
      sid: undefined,
      connectionMessage: cause instanceof Error ? cause.message : 'The NAS could not be reached.',
      lastConnectionCheck: checkedAt,
    }
  }
}

async function fetchSynologyAudio(track: Track, device: NasDevice) {
  if (!track.sourcePath) throw new Error('This track does not include a Synology file path.')
  if (!device.sid) throw new Error(`Reconnect ${device.name} before streaming or downloading from Synology.`)
  const params = {
    api: 'SYNO.FileStation.Download',
    version: '2',
    method: 'download',
    path: JSON.stringify([track.sourcePath]),
    mode: JSON.stringify('open'),
    _sid: device.sid,
  }
  const target = targetForDevice(device)
  let response: Response
  if (target.mode === 'local') {
    const url = new URL('/webapi/entry.cgi', target.baseUrl)
    response = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    })
  } else {
    response = await fetch('/api/synology', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: target.mode,
        host: target.host,
        port: target.port,
        quickConnectId: target.quickConnectId,
        params,
      }),
    })
  }
  const contentType = response.headers.get('Content-Type') || ''
  if (contentType.includes('application/json')) {
    const payload = await response.json().catch(() => null) as { success?: boolean; error?: { code?: number; message?: string } } | null
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error?.message || dsmErrorMessage(payload?.error?.code, 'SYNO.FileStation.Download'))
    }
    throw new Error('DSM returned an unexpected response instead of the audio file.')
  }
  if (!response.ok) {
    throw new Error(`Synology could not provide this audio file (HTTP ${response.status}).`)
  }
  return response.blob()
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function IconPlay({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5.14v14l11-7-11-7z" />
    </svg>
  )
}

function IconPause({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  )
}

function IconSkipNext({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
    </svg>
  )
}

function IconSkipPrev({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
    </svg>
  )
}

function IconVolume({ level }: { level: number }) {
  if (level === 0) return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
      <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
    </svg>
  )
  if (level < 0.5) return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
    </svg>
  )
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
    </svg>
  )
}

function IconShuffle({ active }: { active: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" opacity={active ? 1 : 0.35}>
      <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
    </svg>
  )
}

function IconRepeat({ active }: { active: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" opacity={active ? 1 : 0.35}>
      <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
    </svg>
  )
}

function IconMusic({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  )
}

function IconMood({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.5l1.45 4.05L17.5 8l-4.05 1.45L12 13.5l-1.45-4.05L6.5 8l4.05-1.45L12 2.5zm6.25 9l.9 2.35 2.35.9-2.35.9-.9 2.35-.9-2.35-2.35-.9 2.35-.9.9-2.35zM7.25 13l1.2 3.3 3.3 1.2-3.3 1.2L7.25 22l-1.2-3.3-3.3-1.2 3.3-1.2L7.25 13z" />
    </svg>
  )
}

function IconClock({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.25 2" />
    </svg>
  )
}

function IconAlbum({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z" />
    </svg>
  )
}

function IconList({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" />
    </svg>
  )
}

function IconQueue({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h11M4 11h8M4 16h5" />
      <path d="M17 11v7.5a2.5 2.5 0 1 1-2-2.45V12l5-1.2v5.7" />
    </svg>
  )
}

function IconServer({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M20 3H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 6H4V5h16v4zm0 4H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2zm0 6H4v-4h16v4z" />
      <circle cx="18" cy="7" r="1" fill="currentColor" />
      <circle cx="18" cy="17" r="1" fill="currentColor" />
    </svg>
  )
}

function IconRadio({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 8 13.5-4" />
      <rect x="3" y="8" width="18" height="12" rx="3" />
      <circle cx="9" cy="14" r="3" />
      <path d="M15 12h3M15 15h3M15 18h2" />
    </svg>
  )
}

function IconPlus({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
    </svg>
  )
}

function IconRefresh({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
  )
}

function IconTrash({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
    </svg>
  )
}

function IconFolder({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
    </svg>
  )
}

function IconDownload({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
    </svg>
  )
}

function IconCloud({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
    </svg>
  )
}

function IconCheck({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </svg>
  )
}

function IconSettings({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65-2-3.46-2.49 1a7.4 7.4 0 0 0-1.69-.98L15 3.27h-4l-.36 2.65c-.62.25-1.18.58-1.7.98l-2.48-1-2 3.46 2.1 1.65c-.04.33-.07.66-.07.99s.03.65.07.98l-2.1 1.65 2 3.46 2.48-1c.52.4 1.09.73 1.7.98l.36 2.66h4l.36-2.66c.61-.25 1.18-.58 1.69-.98l2.49 1 2-3.46-2.11-1.65zM13 15.5A3.5 3.5 0 1 1 13 8a3.5 3.5 0 0 1 0 7.5z" />
    </svg>
  )
}

function IconHeart({ size = 16, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  )
}

function hasMeaningfulArtwork(cover: string | undefined) {
  return Boolean(cover && !/\/icon-(?:192|512)\.png(?:$|\?)/.test(cover))
}

function artworkPalette(track: Pick<Track, 'album' | 'artist' | 'title'>) {
  const seed = track.album && track.album !== 'On this device'
    ? `${track.album}|${track.artist}`
    : `${track.title}|${track.artist}`
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const hue = Math.abs(hash) % 360
  const secondHue = (hue + 42 + (Math.abs(hash >> 8) % 78)) % 360
  return [`hsl(${hue} 62% 44%)`, `hsl(${secondHue} 70% 24%)`] as const
}

function artworkInitials(track: Pick<Track, 'album' | 'artist' | 'title'>) {
  const source = track.album && track.album !== 'On this device' ? track.album : track.artist || track.title
  const words = source.split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : source.slice(0, 2)).toLocaleUpperCase()
}

function TrackArtwork({
  track,
  alt = '',
  className = '',
  style,
}: {
  track: Pick<Track, 'album' | 'artist' | 'title' | 'cover'>
  alt?: string
  className?: string
  style?: CSSProperties
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [track.cover])
  if (hasMeaningfulArtwork(track.cover) && !failed) {
    return <img className={className} src={track.cover} alt={alt} style={style} onError={() => setFailed(true)} />
  }
  const [first, second] = artworkPalette(track)
  return (
    <span
      className={`generated-track-art ${className}`.trim()}
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      style={{ ...style, background: `linear-gradient(145deg, ${first}, ${second})` }}
    >
      <span aria-hidden="true"><IconMusic size={28} /></span>
      <b aria-hidden="true">{artworkInitials(track)}</b>
    </span>
  )
}

// ─── Sources View ────────────────────────────────────────────────────────────

const inputStyle: CSSProperties = {
  width: '100%',
  background: '#0e0d0c',
  border: '1px solid #2e2a24',
  borderRadius: 6,
  padding: '8px 12px',
  color: '#e6e1d9',
  fontSize: 13,
  outline: 'none',
  fontFamily: "'DM Sans', system-ui, sans-serif",
}

const labelStyle: CSSProperties = {
  fontSize: 11,
  color: '#5a5248',
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  marginBottom: 6,
  display: 'block',
}

function AddDeviceModal({
  onAdd,
  onReconnect,
  onClose,
  existingDevice,
  mode = 'manage',
}: {
  onAdd: (d: NasDevice, tracks: Track[]) => void
  onReconnect: (device: NasDevice) => void
  onClose: () => void
  existingDevice?: NasDevice | null
  mode?: 'manage' | 'reconnect'
}) {
  const [name, setName] = useState(existingDevice?.name ?? '')
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(existingDevice?.connectionMode ?? 'ddns')
  const [host, setHost] = useState(existingDevice?.host ?? '')
  const [port, setPort] = useState(existingDevice?.port || '5001')
  const [quickConnectId, setQuickConnectId] = useState(existingDevice?.quickConnectId ?? '')
  const [username, setUsername] = useState(existingDevice?.username ?? '')
  const [password, setPassword] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [otpRequired, setOtpRequired] = useState(false)
  const [secure, setSecure] = useState(existingDevice?.baseUrl?.startsWith('http://') ? false : true)
  const [remember, setRemember] = useState(existingDevice?.saved ?? true)
  const [step, setStep] = useState<'form' | 'connecting' | 'shares' | 'scanning'>('form')
  const [shares, setShares] = useState<SynologyFolderChoice[]>([])
  const [browsePath, setBrowsePath] = useState<string | null>(null)
  const [loadedPaths, setLoadedPaths] = useState<string[]>([])
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<string[]>(existingDevice?.shares.map(share => share.path) ?? [])
  const [sid, setSid] = useState('')
  const [error, setError] = useState('')
  const [permissionIssue, setPermissionIssue] = useState(false)
  const [progress, setProgress] = useState({ folders: 0, tracks: 0 })
  const reconnectOnly = mode === 'reconnect' && Boolean(existingDevice)

  const normalizedHost = host.trim().replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0]
  const baseUrl = `${secure ? 'https' : 'http'}://${normalizedHost}${port ? `:${port}` : ''}`
  const target: DsmTarget = { mode: connectionMode, baseUrl, host: normalizedHost, port, quickConnectId: quickConnectId.trim() }
  const canConnect = connectionMode === 'quickconnect'
    ? /^[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$|^[A-Za-z]$/.test(quickConnectId.trim())
    : Boolean(normalizedHost)
  const folderByPath = new Map(shares.map(folder => [folder.path, folder]))
  const visibleFolders = shares
    .filter(folder => folder.parentPath === browsePath)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const breadcrumbFolders = browsePath
    ? browsePath.split('/').filter(Boolean).map((part, index, all) => {
      const path = `/${all.slice(0, index + 1).join('/')}`
      return { path, name: folderByPath.get(path)?.name ?? part }
    })
    : []

  async function discoverShares() {
    if (!canConnect || !username || !password) return
    if (otpRequired && otpCode.length < 6) {
      setError('Enter the current verification code from your authenticator app.')
      return
    }
    setError('')
    setPermissionIssue(false)
    setProgress({ folders: 0, tracks: 0 })
    setStep('connecting')
    try {
      const result = await connectToSynology(target, username, password, otpCode)
      setOtpCode('')
      setOtpRequired(false)
      setSid(result.sid)
      if (reconnectOnly && existingDevice) {
        const address = connectionMode === 'quickconnect' ? quickConnectId.trim() : normalizedHost
        onReconnect({
          ...existingDevice,
          name: name || existingDevice.name || `DiskStation (${address})`,
          host: normalizedHost,
          port: connectionMode === 'quickconnect' ? '443' : port,
          protocol: connectionMode === 'quickconnect' ? 'QuickConnect + DSM API' : 'DSM File Station API',
          username,
          remote: connectionMode !== 'local',
          remoteAddress: address,
          baseUrl: connectionMode === 'local' ? baseUrl : undefined,
          connectionMode,
          quickConnectId: connectionMode === 'quickconnect' ? quickConnectId.trim() : undefined,
          saved: existingDevice.saved ?? true,
          sid: result.sid,
          status: 'connected',
          connectionMessage: 'Reconnected successfully. Your saved folders and music index were preserved.',
          lastConnectionCheck: new Date().toISOString(),
        })
        onClose()
        return
      }
      const rootFolders: SynologyFolderChoice[] = result.shares.map(share => ({
        ...share,
        parentPath: null,
        depth: 0,
        trackCount: 0,
      }))
      const savedFolders: SynologyFolderChoice[] = (existingDevice?.shares ?? []).map(folder => ({
        name: folder.name || folder.path.split('/').filter(Boolean).at(-1) || 'Music folder',
        path: folder.path,
        isdir: true,
        parentPath: parentFolderPath(folder.path),
        depth: folderDepth(folder.path),
        trackCount: folder.trackCount,
      }))
      setShares(Array.from(new Map([...rootFolders, ...savedFolders].map(folder => [folder.path, folder])).values()))
      setSelectedPaths(savedFolders.map(folder => folder.path))
      setBrowsePath(null)
      setLoadedPaths([])
      setStep('shares')
    } catch (cause) {
      if (cause instanceof DsmApiError && cause.api === 'SYNO.API.Auth' && cause.code === 403) {
        setOtpRequired(true)
        setOtpCode('')
        setError('DSM requires two-factor authentication. Enter the current code from your authenticator app, then connect again.')
        setStep('form')
        return
      }
      if (cause instanceof DsmApiError && cause.api === 'SYNO.API.Auth' && cause.code === 404) {
        setOtpRequired(true)
        setOtpCode('')
        setError('DSM rejected that verification code. Wait for a new code and try again.')
        setStep('form')
        return
      }
      if (cause instanceof DsmApiError && (
        (cause.api === 'SYNO.API.Auth' && cause.code === 402)
        || (cause.api.startsWith('SYNO.FileStation.') && [105, 403, 407].includes(cause.code ?? -1))
      )) {
        setPermissionIssue(true)
        setError('DSM reached the NAS, but this account does not have effective File Station application access. Shared-folder Read permission alone is not enough for the File Station API.')
        setStep('form')
        return
      }
      const message = cause instanceof TypeError && connectionMode === 'local'
        ? 'Chrome blocked the local NAS request. Try DDNS or QuickConnect, or confirm DSM has a trusted HTTPS certificate and permits private-network browser access.'
        : cause instanceof Error ? cause.message : 'Unable to connect to DSM.'
      setError(message)
      setStep('form')
    }
  }

  function toggleFolder(path: string) {
    setSelectedPaths(paths => {
      if (paths.includes(path)) return paths.filter(item => item !== path)
      return [...paths.filter(item => !foldersOverlap(item, path)), path]
    })
  }

  async function openFolder(folder: SynologyFolderChoice) {
    if (loadingPath) return
    setError('')
    if (loadedPaths.includes(folder.path)) {
      setBrowsePath(folder.path)
      return
    }
    setLoadingPath(folder.path)
    try {
      const children = await listSynologySubfolders(target, sid, folder.path)
      const childChoices: SynologyFolderChoice[] = children.map(child => ({
        ...child,
        parentPath: folder.path,
        depth: folder.depth + 1,
        trackCount: 0,
      }))
      setShares(current => {
        const merged = new Map(current.map(item => [item.path, item]))
        childChoices.forEach(item => merged.set(item.path, { ...item, trackCount: merged.get(item.path)?.trackCount ?? 0 }))
        return Array.from(merged.values())
      })
      setLoadedPaths(paths => [...paths, folder.path])
      setBrowsePath(folder.path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not open ${folder.name}.`)
    } finally {
      setLoadingPath(null)
    }
  }

  async function addAndScan() {
    const selected = shares.filter(share => selectedPaths.includes(share.path))
    if (!selected.length) return
    setError('')
    setStep('scanning')
    try {
      setProgress({ folders: 0, tracks: 0 })
      const discovery = await discoverSynologyFolders(target, sid, selected, (folders, tracks) => setProgress({ folders, tracks }))
      const chosenTracks = discovery.tracks
      if (!chosenTracks.length) throw new Error('No supported audio files were found in the selected folders.')
      const scannedFolders = new Map(discovery.folders.map(folder => [folder.path, folder]))
      const deviceId = existingDevice?.id ?? `nas-${Date.now()}`
      const address = connectionMode === 'quickconnect' ? quickConnectId.trim() : normalizedHost
      const device: NasDevice = {
        id: deviceId,
        name: name || `DiskStation (${address})`,
        type: 'synology',
        host: normalizedHost,
        port: connectionMode === 'quickconnect' ? '443' : port,
        protocol: connectionMode === 'quickconnect' ? 'QuickConnect + DSM API' : 'DSM File Station API',
        username,
        sharePath: selected.map(s => s.path).join(', '),
        status: 'connected',
        lastSync: new Date().toISOString(),
        totalTracks: chosenTracks.length,
        shares: selected.map(s => ({
          path: s.path,
          name: s.name,
          trackCount: scannedFolders.get(s.path)?.trackCount ?? chosenTracks.filter(track => track.sourcePath && pathIncludesFolder(track.sourcePath, s.path)).length,
        })),
        remote: connectionMode !== 'local',
        remoteAddress: address,
        baseUrl: connectionMode === 'local' ? baseUrl : undefined,
        connectionMode,
        quickConnectId: connectionMode === 'quickconnect' ? quickConnectId.trim() : undefined,
        saved: remember,
        sid,
      }
      onAdd(device, chosenTracks.map(track => ({ ...track, sourceId: deviceId })))
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The folder scan could not finish.')
      setStep('shares')
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="add-source-modal" style={{ background: '#1a1815', border: '1px solid #2e2a24', borderRadius: 12, width: 520, maxWidth: 'calc(100vw - 24px)', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 32px 80px rgba(0,0,0,0.6)' }}>
        {/* Header */}
        <div style={{ padding: '24px 28px 20px', borderBottom: '1px solid #231f1b' }}>
          <div style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: 20, color: '#e6e1d9' }}>{reconnectOnly ? 'Reconnect Synology' : existingDevice ? 'Edit Synology Source' : 'Add Synology DiskStation'}</div>
          <div style={{ fontSize: 12, color: '#5a5248', marginTop: 4 }}>{reconnectOnly ? 'Sign in again without deleting the source, saved folders, or music index.' : existingDevice ? 'Sign in, browse from your shared folders, and update the folders you selected' : 'Connect to DSM, start with your shared folders, then open one to choose a folder inside it'}</div>
        </div>

        <div style={{ padding: '24px 28px' }}>
          {step === 'form' || step === 'connecting' ? <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={labelStyle}>Connection method</label>
              <div className="connection-methods" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {([
                  ['local', 'Local IP', 'Same Wi-Fi'],
                  ['ddns', 'DDNS', 'Most reliable'],
                  ['quickconnect', 'QuickConnect', 'No port forwarding'],
                ] as const).map(([mode, title, caption]) => (
                  <button key={mode} onClick={() => { setConnectionMode(mode); setError(''); setPermissionIssue(false); if (mode === 'ddns') { setSecure(true); if (port === '5000') setPort('5001') } }} style={{ padding: '10px 8px', borderRadius: 8, border: `1px solid ${connectionMode === mode ? '#d4924a' : '#2e2a24'}`, background: connectionMode === mode ? '#241b13' : '#141210', color: connectionMode === mode ? '#e6e1d9' : '#7a736a', textAlign: 'left', cursor: 'pointer' }}>
                    <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>{title}</span>
                    <span style={{ display: 'block', fontSize: 10, color: connectionMode === mode ? '#a86e30' : '#4d4740', marginTop: 2 }}>{caption}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label style={labelStyle}>Display Name</label>
              <input style={inputStyle} placeholder="My DiskStation" value={name} onChange={e => setName(e.target.value)} />
            </div>

            {connectionMode === 'quickconnect' ? (
              <div>
                <label style={labelStyle}>QuickConnect ID</label>
                <input style={inputStyle} placeholder="YourQuickConnectID" value={quickConnectId} onChange={e => setQuickConnectId(e.target.value)} />
                <div style={{ fontSize: 11, lineHeight: 1.5, color: '#6c655b', marginTop: 7 }}>QuickConnect must be enabled in DSM. Tunestack will ask Synology for a secure DSM route and use its relay when needed.</div>
              </div>
            ) : (
              <div className="connection-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: 10 }}>
                <div>
                  <label style={labelStyle}>{connectionMode === 'ddns' ? 'DDNS hostname' : 'DSM hostname or local IP'}</label>
                  <input style={inputStyle} placeholder={connectionMode === 'ddns' ? 'your-name.synology.me' : '192.168.1.100'} value={host} onChange={e => setHost(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Port</label>
                  <input style={inputStyle} value={port} onChange={e => setPort(e.target.value)} />
                </div>
              </div>
            )}

              <div className="credential-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={labelStyle}>Username</label>
                  <input style={inputStyle} autoComplete="username" placeholder="music-reader" value={username} onChange={e => setUsername(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Password</label>
                  <input style={inputStyle} type="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
                </div>
              </div>
            <div className={`otp-field ${otpRequired ? 'required' : ''}`}>
              <label style={labelStyle}>2FA verification code <span style={{ textTransform: 'none', letterSpacing: 0 }}>({otpRequired ? 'required' : 'if enabled'})</span></label>
              <input
                style={inputStyle}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={8}
                placeholder="123456"
                value={otpCode}
                onChange={event => setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
              />
              <div className="otp-help">Use the current code from Synology Secure SignIn or your authenticator app. It is never saved.</div>
            </div>
            {connectionMode === 'local' && <div style={{ padding: '14px 16px', borderRadius: 8, border: '1px solid #2e2a24', background: '#141210' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 13, color: '#e6e1d9', fontWeight: 500 }}>Secure HTTPS</div>
                  <div style={{ fontSize: 11, color: '#5a5248', marginTop: 2 }}>Recommended; DSM normally uses port 5001</div>
                </div>
                <button
                  onClick={() => { setSecure(value => !value); setPort(secure ? '5000' : '5001') }}
                  aria-label="Toggle HTTPS"
                  style={{
                    width: 40, height: 22, borderRadius: 11,
                    background: secure ? '#d4924a' : '#2e2a24',
                    border: 'none', cursor: 'pointer', position: 'relative',
                    transition: 'background 0.2s', flexShrink: 0,
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 3, left: secure ? 21 : 3,
                    width: 16, height: 16, borderRadius: '50%', background: '#fff',
                    transition: 'left 0.2s',
                  }} />
                </button>
              </div>
            </div>}
            {connectionMode === 'ddns' && <div style={{ fontSize: 11, lineHeight: 1.5, color: '#6c655b', padding: '11px 12px', borderRadius: 8, background: '#141210', border: '1px solid #2e2a24' }}>DDNS uses Tunestack&apos;s same-origin relay to avoid browser CORS blocks. The hostname must be reachable from the internet over HTTPS with a trusted certificate.</div>}
            {reconnectOnly ? (
              <div className="reconnect-preserve-note">
                <IconCheck size={18} />
                <span><strong>Your library stays intact</strong><small>This only refreshes the DSM login session. It will not rescan or remove your saved folders and tracks.</small></span>
              </div>
            ) : (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '12px 14px', borderRadius: 8, border: '1px solid #2e2a24', background: '#141210' }}>
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={{ marginTop: 2 }} />
                <span>
                  <span style={{ display: 'block', color: '#e6e1d9', fontSize: 12, fontWeight: 500 }}>Save this source and its music index on this device</span>
                  <span style={{ display: 'block', color: '#5a5248', fontSize: 11, lineHeight: 1.5, marginTop: 2 }}>Saves the address, username, selected folders, and scanned tracks. Your password and 2FA code are never saved; a temporary DSM session is kept only for the current app session.</span>
                </span>
              </label>
            )}
            <div style={{ fontSize: 11, lineHeight: 1.5, color: '#6c655b' }}>Use a dedicated read-only DSM account with access only to the music shares you select.</div>
          </div> : null}

          {step === 'connecting' && (
            <div style={{ marginTop: 20, padding: '12px 16px', borderRadius: 8, background: '#0e0d0c', border: '1px solid #2e2a24', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#d4924a', animation: 'pulse 1s infinite' }} />
              <span style={{ fontSize: 13, color: '#a89880' }}>{connectionMode === 'quickconnect' ? 'Resolving QuickConnect and signing in to DSM…' : 'Signing in to DSM and loading shared folders…'}</span>
            </div>
          )}

          {(step === 'shares' || step === 'scanning') && (
            <div>
              <div style={{ fontSize: 13, color: '#a89880', marginBottom: 5 }}>{browsePath ? `Inside ${folderByPath.get(browsePath)?.name ?? browsePath}` : 'Shared folders'}</div>
              <div style={{ fontSize: 11, color: '#6c655b', marginBottom: 12, lineHeight: 1.5 }}>{browsePath ? 'Select a folder here, or open it to continue deeper.' : 'Select a whole shared folder, or open it to choose a folder inside—for example Music → XYZ.'}</div>
              <nav className="folder-breadcrumb" aria-label="Current Synology folder">
                <button type="button" onClick={() => setBrowsePath(null)} className={!browsePath ? 'current' : ''}>Shared folders</button>
                {breadcrumbFolders.map((folder, index) => (
                  <span key={folder.path}>
                    <span aria-hidden="true">›</span>
                    <button type="button" onClick={() => setBrowsePath(folder.path)} className={index === breadcrumbFolders.length - 1 ? 'current' : ''}>{folder.name}</button>
                  </span>
                ))}
              </nav>
              {selectedPaths.length > 0 && (
                <div className="selected-folder-list" aria-label="Selected folders">
                  <span className="selected-folder-label">Selected</span>
                  {selectedPaths.map(path => (
                    <button type="button" key={path} onClick={() => toggleFolder(path)} disabled={step === 'scanning'} title={`Remove ${path}`}>
                      <span>{folderByPath.get(path)?.name ?? path.split('/').filter(Boolean).at(-1)}</span>
                      <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="folder-tree" style={{ display: 'flex', flexDirection: 'column', gap: 7, maxHeight: 310, overflowY: 'auto' }}>
                {visibleFolders.map(share => {
                  const isSelected = selectedPaths.includes(share.path)
                  const containsSelection = selectedPaths.some(path => path !== share.path && pathIncludesFolder(path, share.path))
                  const isLoading = loadingPath === share.path
                  return (
                    <div className={`folder-choice ${isSelected ? 'selected' : ''}`} key={share.path}>
                      <button className="folder-open-button" type="button" disabled={step === 'scanning' || Boolean(loadingPath)} onClick={() => openFolder(share)} aria-label={`Open ${share.name}`}>
                        <IconFolder size={15} />
                        <span className="folder-open-copy">
                          <span className="folder-name">{share.name}</span>
                          <span className="share-path">{share.parentPath ? 'Folder' : 'Shared folder'}{containsSelection ? ' · contains a selected folder' : ''}</span>
                        </span>
                        <span className="folder-open-chevron" aria-hidden="true">{isLoading ? '…' : '›'}</span>
                      </button>
                      <label className="folder-check">
                        <input type="checkbox" disabled={step === 'scanning'} checked={isSelected} onChange={() => toggleFolder(share.path)} />
                        <span>{isSelected ? 'Selected' : 'Select'}</span>
                      </label>
                    </div>
                  )
                })}
              </div>
              {!shares.length && <div style={{ color: '#be7d7d', fontSize: 12 }}>DSM returned no accessible File Station shared folders for this account.</div>}
              {shares.length > 0 && visibleFolders.length === 0 && <div className="folder-empty-state">No subfolders here. Go back and select this folder if it contains your music.</div>}
            </div>
          )}

          {step === 'scanning' && <div style={{ marginTop: 16, color: '#d4924a', fontSize: 12 }}>Scanning only the selected folders… {progress.folders.toLocaleString()} folders · {progress.tracks.toLocaleString()} music files</div>}
          {error && <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: '#231515', border: '1px solid #4a2929', color: '#d79898', fontSize: 12, lineHeight: 1.5 }}>{error}</div>}
          {permissionIssue && (
            <div className="dsm-permission-help">
              <strong>Fix this in DSM</strong>
              <ol>
                <li>Open <b>Control Panel → Application Privileges</b>.</li>
                <li>Select <b>File Station</b>, choose <b>Edit</b>, and allow this user.</li>
                <li>Use <b>Permission Viewer</b> to check the effective user and IP rule.</li>
                <li>Sign into File Station as this exact user and confirm the Music folder opens.</li>
              </ol>
              {connectionMode === 'quickconnect' && <p>For QuickConnect, also enable <b>File sharing</b> under QuickConnect → Advanced Settings → Permission.</p>}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
            <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #2e2a24', background: 'transparent', color: '#7a736a', fontSize: 13, cursor: 'pointer' }}>
              Cancel
            </button>
            {step === 'form' || step === 'connecting' ? (
              <button onClick={discoverShares} disabled={!canConnect || !username || !password || (otpRequired && otpCode.length < 6) || step !== 'form'} style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#d4924a', color: '#0e0d0c', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: !canConnect || !username || !password || (otpRequired && otpCode.length < 6) || step !== 'form' ? 0.4 : 1 }}>
                {step === 'connecting' ? 'Connecting…' : reconnectOnly ? otpCode ? 'Verify & Reconnect' : 'Reconnect' : otpCode ? 'Verify & Browse Shared Folders' : 'Connect & Browse Shared Folders'}
              </button>
            ) : (
              <button onClick={addAndScan} disabled={!selectedPaths.length || step === 'scanning'} style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#d4924a', color: '#0e0d0c', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: !selectedPaths.length || step === 'scanning' ? 0.4 : 1 }}>
                {step === 'scanning' ? 'Adding…' : 'Add Selected Folders'}
              </button>
            )}
          </div>
        </div>
      </div>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  )
}

function DeviceCard({
  device,
  onRemove,
  onReconnect,
  onEdit,
}: {
  device: NasDevice
  onRemove: () => void
  onReconnect: () => void
  onEdit: () => void
}) {
  const [expanded, setExpanded] = useState(device.status === 'connected')
  const preset = NAS_PRESETS[device.type]

  const statusColors: Record<NasStatus, { dot: string; text: string; label: string }> = {
    connected: { dot: '#5a9e5a', text: '#7dbe7d', label: 'Connected' },
    disconnected: { dot: '#5a5248', text: '#7a736a', label: 'Reconnect to play' },
    checking: { dot: '#d4924a', text: '#d4924a', label: 'Checking…' },
    scanning: { dot: '#d4924a', text: '#d4924a', label: 'Scanning…' },
    error: { dot: '#9e5a5a', text: '#be7d7d', label: 'Error' },
  }
  const sc = statusColors[device.status]

  return (
    <div className="source-card" style={{ background: '#1a1815', border: '1px solid #2e2a24', borderRadius: 10, overflow: 'hidden' }}>
      {/* Card header */}
      <div style={{ padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 16 }}>
        {/* NAS icon */}
        <div style={{ width: 44, height: 44, borderRadius: 8, background: '#231f1b', border: '1px solid #2e2a24', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5a5248', flexShrink: 0 }}>
          <IconServer size={20} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 15, color: '#e6e1d9', fontWeight: 500 }}>{device.name}</span>
            <span style={{ fontSize: 10, background: '#231f1b', border: '1px solid #2e2a24', color: '#5a5248', borderRadius: 4, padding: '1px 7px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              {device.connectionMode === 'quickconnect' ? 'QuickConnect' : preset.protocol}
            </span>
            {device.remote && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, background: '#1a1a2e', border: '1px solid #2e2e4a', color: '#7878c8', borderRadius: 4, padding: '1px 7px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                <IconCloud size={10} /> Remote
              </span>
            )}
            {device.saved !== false && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, background: '#172018', border: '1px solid #293a2a', color: '#70a873', borderRadius: 4, padding: '1px 7px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                <IconCheck size={10} /> Saved
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#5a5248', marginTop: 3 }}>
            {device.connectionMode === 'quickconnect' ? `QuickConnect: ${device.quickConnectId}` : `${device.host}:${device.port}`} · {device.sharePath}
          </div>
        </div>

        {/* Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: sc.dot, boxShadow: device.status === 'connected' ? `0 0 6px ${sc.dot}` : 'none' }} />
          <span style={{ fontSize: 12, color: sc.text }}>{sc.label}</span>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button className={`reconnect-device-button ${device.status !== 'connected' ? 'needed' : ''}`} onClick={onReconnect} title="Reconnect this saved Synology source">
            <IconRefresh size={13} /><span>{device.status === 'checking' ? 'Reconnect now' : 'Reconnect'}</span>
          </button>
          <button className="edit-folders-button" onClick={onEdit} title="Edit connection and selected folders" style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #2e2a24', background: 'transparent', color: '#7a736a', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <IconFolder size={13} /><span>Edit folders</span>
          </button>
          <button onClick={onRemove} title="Remove" style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #2e2a24', background: 'transparent', color: '#5a5248', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <IconTrash />
          </button>
          <button onClick={() => setExpanded(e => !e)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #2e2a24', background: 'transparent', color: '#5a5248', cursor: 'pointer', fontSize: 12 }}>
            {expanded ? '▴' : '▾'}
          </button>
        </div>
      </div>
      {/* Stats bar */}
      <div style={{ display: 'flex', borderTop: '1px solid #231f1b', padding: '10px 20px', gap: 32 }}>
        <div>
          <div style={{ fontSize: 18, color: '#e6e1d9', fontWeight: 300, fontVariantNumeric: 'tabular-nums' }}>{device.totalTracks.toLocaleString()}</div>
          <div style={{ fontSize: 10, color: '#3d3830', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Tracks</div>
        </div>
        <div>
          <div style={{ fontSize: 18, color: '#e6e1d9', fontWeight: 300 }}>{device.shares.length}</div>
          <div style={{ fontSize: 10, color: '#3d3830', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Folders</div>
        </div>
        {device.remote && device.remoteAddress && (
          <div>
            <div style={{ fontSize: 12, color: '#7878c8', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{device.remoteAddress}</div>
            <div style={{ fontSize: 10, color: '#3d3830', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Remote host</div>
          </div>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          {device.lastSync && (
            <div style={{ fontSize: 11, color: '#3d3830' }}>Synced {device.lastSync}</div>
          )}
        </div>
      </div>
      {device.connectionMessage && (
        <p className={`source-connection-message ${device.status}`}>
          {device.connectionMessage}
        </p>
      )}

      {/* Expanded shares */}
      {expanded && device.shares.length > 0 && (
        <div style={{ borderTop: '1px solid #231f1b', padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ fontSize: 10, color: '#3d3830', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Indexed Folders</div>
          {device.shares.map(share => (
            <div key={share.path} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 6, background: '#141210' }}>
              <span style={{ color: '#d4924a', opacity: 0.6 }}><IconFolder size={13} /></span>
              <span style={{ fontSize: 12, color: '#a89880', flex: 1, fontFamily: 'monospace' }}>{share.path}</span>
              <span style={{ fontSize: 11, color: '#5a5248' }}>{share.trackCount.toLocaleString()} tracks</span>
            </div>
          ))}
        </div>
      )}
      {expanded && device.status === 'scanning' && (
        <div style={{ borderTop: '1px solid #231f1b', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#d4924a', animation: 'pulse 1s infinite' }} />
          <span style={{ fontSize: 12, color: '#7a736a' }}>Scanning music library… this may take a few minutes.</span>
        </div>
      )}
    </div>
  )
}

function SourcesView({
  devices,
  onAdd,
  onReconnect,
  onRemove,
  embedded = false,
}: {
  devices: NasDevice[]
  onAdd: (device: NasDevice, tracks: Track[]) => void
  onReconnect: (device: NasDevice) => void
  onRemove: (id: string) => void
  embedded?: boolean
}) {
  const [showModal, setShowModal] = useState(false)
  const [editingDevice, setEditingDevice] = useState<NasDevice | null>(null)
  const [modalMode, setModalMode] = useState<'manage' | 'reconnect'>('manage')

  function openAddModal() {
    setEditingDevice(null)
    setModalMode('manage')
    setShowModal(true)
  }

  function openReconnectModal(device: NasDevice) {
    setEditingDevice({
      ...device,
      connectionMode: device.connectionMode ?? (device.remote ? 'ddns' : 'local'),
      saved: device.saved ?? true,
    })
    setModalMode('reconnect')
    setShowModal(true)
  }

  function openEditModal(device: NasDevice) {
    setEditingDevice({
      ...device,
      connectionMode: device.connectionMode ?? (device.remote ? 'ddns' : 'local'),
      saved: device.saved ?? true,
    })
    setModalMode('manage')
    setShowModal(true)
  }

  return (
    <div className={embedded ? 'sources-view embedded-sources' : 'sources-view'} style={{ flex: embedded ? undefined : 1, display: 'flex', flexDirection: 'column', overflow: embedded ? 'visible' : 'hidden' }}>
      {/* Header */}
      <div className="sources-header" style={{ padding: embedded ? '0 0 18px' : '32px 28px 20px', borderBottom: '1px solid #1e1b17', flexShrink: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <div className="section-eyebrow">Connections</div>
          <h1 style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: embedded ? 22 : 28, color: '#e6e1d9', margin: 0, letterSpacing: '-0.02em' }}>Synology Sources</h1>
          <div style={{ fontSize: 12, color: '#5a5248', marginTop: 4 }}>
            {devices.length} {devices.length === 1 ? 'device' : 'devices'} · {devices.reduce((a, d) => a + d.totalTracks, 0).toLocaleString()} total tracks
          </div>
        </div>
        <button className="primary-action"
          onClick={openAddModal}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderRadius: 8, border: 'none', background: '#d4924a', color: '#0e0d0c', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          <IconPlus size={15} /> Add Source
        </button>
      </div>

      <div className="source-note" style={{ padding: embedded ? '12px 0' : '12px 28px', borderBottom: '1px solid #1e1b17', fontSize: 11, color: '#6c655b', lineHeight: 1.5 }}>
        DDNS and QuickConnect use a secure same-origin relay to avoid browser CORS blocks. Local IP mode still depends on your browser and DSM certificate settings.
      </div>

      {devices.length > 0 && (
        <section className="synology-reconnect-section" aria-label="Synology connection status">
          <header>
            <span><IconRefresh size={20} /></span>
            <span><strong>Reconnect saved Synology sources</strong><small>Tunestack checks these connections whenever the app opens. Expired DSM sessions can be refreshed without deleting or rescanning anything.</small></span>
          </header>
          <div>
            {devices.map(device => (
              <div className={`synology-reconnect-row status-${device.status}`} key={device.id}>
                <span className="synology-status-dot" />
                <span>
                  <strong>{device.name}</strong>
                  <small>{device.connectionMessage || (device.status === 'checking' ? 'Checking the saved connection…' : device.status === 'connected' ? 'Ready to stream' : 'Sign in again to reconnect')}</small>
                </span>
                <button type="button" onClick={() => openReconnectModal(device)}>
                  <IconRefresh size={15} /> {device.status === 'checking' ? 'Reconnect now' : device.status === 'connected' ? 'Reconnect again' : 'Reconnect'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Device list */}
      <div className="source-device-list" style={{ flex: embedded ? undefined : 1, overflowY: embedded ? 'visible' : 'auto', padding: embedded ? '18px 0 0' : 28 }}>
        {devices.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: embedded ? 190 : undefined, height: embedded ? undefined : '100%', gap: 16, color: '#3d3830' }}>
            <IconServer size={48} />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, color: '#5a5248', marginBottom: 6 }}>No network sources</div>
              <div style={{ fontSize: 13, color: '#3d3830' }}>Add your Synology account, choose shared folders, and scan them recursively for music.</div>
            </div>
            <button onClick={openAddModal} style={{ marginTop: 8, padding: '9px 20px', borderRadius: 8, border: '1px solid #2e2a24', background: 'transparent', color: '#7a736a', fontSize: 13, cursor: 'pointer' }}>
              Add your first source
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {devices.map(d => (
              <DeviceCard
                key={d.id}
                device={d}
                onRemove={() => onRemove(d.id)}
                onReconnect={() => openReconnectModal(d)}
                onEdit={() => openEditModal(d)}
              />
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <AddDeviceModal
          existingDevice={editingDevice}
          mode={modalMode}
          onAdd={onAdd}
          onReconnect={onReconnect}
          onClose={() => { setShowModal(false); setEditingDevice(null) }}
        />
      )}
    </div>
  )
}

// ─── Components ──────────────────────────────────────────────────────────────

function Sidebar({
  view,
  setView,
  navOrder,
}: {
  view: View
  setView: (v: View) => void
  navOrder: NavView[]
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

  const navDefinitions: Record<NavView, { id: NavView; label: string; icon: ReactNode }> = {
    local: { id: 'local', label: 'Local music', icon: <IconDownload size={28} /> },
    synology: { id: 'synology', label: 'Synology', icon: <IconServer size={28} /> },
    radio: { id: 'radio', label: 'Local radio', icon: <IconRadio size={28} /> },
    favorites: { id: 'favorites', label: 'Favorites', icon: <IconHeart size={28} filled /> },
    moods: { id: 'moods', label: 'Moods', icon: <IconMood size={28} /> },
    library: { id: 'library', label: 'All Music', icon: <IconList size={28} /> },
    albums: { id: 'albums', label: 'Albums', icon: <IconAlbum size={28} /> },
    nowplaying: { id: 'nowplaying', label: 'Now Playing', icon: <IconMusic size={28} /> },
    settings: { id: 'settings', label: 'Settings', icon: <IconSettings size={28} /> },
  }
  const navItems = navOrder.map(id => navDefinitions[id]).filter(Boolean)

  return (
    <>
      <button
        className={`sidebar-edge-handle ${open ? 'drawer-open' : ''}`}
        type="button"
        aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
        aria-controls="tunestack-navigation-drawer"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h13M4 12h16M4 17h10" />
        </svg>
        <small>MENU</small>
      </button>
      {open && (
        <button
          className="navigation-drawer-backdrop"
          type="button"
          aria-label="Close navigation menu"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        id="tunestack-navigation-drawer"
        className={`app-sidebar auto-hide-sidebar ${open ? 'open' : ''}`}
        aria-label="App navigation"
        aria-hidden={!open}
      >
        <div className="navigation-drawer-header">
          <div>
            <span className="navigation-drawer-logo"><IconMusic size={24} /></span>
            <span>
              <strong>Tunestack</strong>
              <small>Your music</small>
            </span>
          </div>
          <button type="button" aria-label="Close navigation menu" onClick={() => setOpen(false)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <nav>
          {navItems.map(item => (
            <button
              className={`mobile-nav-item ${view === item.id ? 'active' : ''}`}
              key={item.id}
              onClick={() => {
                setView(item.id)
                setOpen(false)
              }}
              aria-label={item.label}
              aria-current={view === item.id ? 'page' : undefined}
            >
              <span>{item.icon}</span>
              <small>{item.label}</small>
            </button>
          ))}
        </nav>
        <div className="navigation-drawer-footer">Change menu order anytime in Settings.</div>
      </aside>
    </>
  )
}

function TrackRow({
  track,
  index,
  isActive,
  isPlaying,
  onPlay,
  liked,
  onToggleLike,
  playlists,
  onAddToPlaylist,
}: {
  track: Track
  index: number
  isActive: boolean
  isPlaying: boolean
  onPlay: () => void
  liked: boolean
  onToggleLike: () => void
  playlists: Playlist[]
  onAddToPlaylist: (playlistId: string) => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div className={`track-row ${isActive ? 'active' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onPlay}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPlay() } }}
      role="button"
      tabIndex={0}
      style={{
        display: 'grid',
        gridTemplateColumns: '32px 1fr 180px 60px 82px',
        alignItems: 'center',
        gap: 12,
        padding: '8px 20px',
        borderRadius: 6,
        background: isActive ? '#1c1915' : hovered ? '#151210' : 'transparent',
        cursor: 'pointer',
        transition: 'background 0.1s',
      }}
    >
      {/* Index / play indicator */}
      <div style={{ textAlign: 'center', fontSize: 12, color: isActive ? '#d4924a' : '#5a5248', fontWeight: 500 }}>
        {hovered || (isActive && isPlaying) ? (
          <button onClick={event => { event.stopPropagation(); onPlay() }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: isActive ? '#d4924a' : '#a89880', padding: 0, lineHeight: 1 }}>
            {isActive && isPlaying ? <IconPause size={14} /> : <IconPlay size={14} />}
          </button>
        ) : (
          isActive ? <span style={{ color: '#d4924a' }}>♦</span> : index + 1
        )}
      </div>

      {/* Title + artist */}
      <div style={{ overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 14, color: isActive ? '#d4924a' : '#e6e1d9', fontWeight: 400, overflow: 'hidden', whiteSpace: 'nowrap' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.title}</span>
          {track.mood && <span className={`mood-badge mood-${track.mood.toLowerCase()}`} title={`${track.moodConfidence || 0}% confidence`}>{track.mood}</span>}
        </div>
        <div style={{ fontSize: 12, color: '#7a736a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {track.artist}
        </div>
      </div>

      {/* Album */}
      <div style={{ fontSize: 12, color: '#5a5248', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {track.album}
      </div>

      {/* Duration */}
      <div style={{ fontSize: 12, color: '#5a5248', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {fmtTrackDuration(track.duration)}
      </div>

      {/* Like */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
        <select
          aria-label={`Add ${track.title} to playlist`}
          value=""
          onClick={event => event.stopPropagation()}
          onChange={e => { if (e.target.value) onAddToPlaylist(e.target.value) }}
          style={{ width: 34, color: '#7a736a', background: '#151210', border: '1px solid #2e2a24', borderRadius: 4, opacity: hovered ? 1 : 0, cursor: 'pointer' }}
        >
          <option value="">＋</option>
          {playlists.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className={`favorite-button ${liked ? 'liked' : ''}`}
          onClick={event => { event.stopPropagation(); onToggleLike() }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: liked ? '#d4924a' : '#3d3830', padding: 4, opacity: hovered || liked ? 1 : 0, transition: 'opacity 0.15s' }}
        >
          <IconHeart filled={liked} />
        </button>
      </div>
    </div>
  )
}

function LibraryView({
  tracks,
  activeTrack,
  isPlaying,
  onPlay,
  favorites,
  onToggleFavorite,
  playlists,
  onAddToPlaylist,
  title = 'Library',
  headerAction,
  headerContent,
  emptyMessage,
}: {
  tracks: Track[]
  activeTrack: Track | null
  isPlaying: boolean
  onPlay: (track: Track, queue: Track[]) => void
  favorites: number[]
  onToggleFavorite: (trackId: number) => void
  playlists: Playlist[]
  onAddToPlaylist: (playlistId: string, trackId: number) => void
  title?: string
  headerAction?: ReactNode
  headerContent?: ReactNode
  emptyMessage?: string
}) {
  const [query, setQuery] = useState('')
  const [genre, setGenre] = useState('All genres')
  const [sort, setSort] = useState<'title' | 'artist' | 'year' | 'mood'>('title')
  const genres = ['All genres', ...Array.from(new Set(tracks.map(t => t.genre))).sort()]
  const visibleTracks = tracks
    .filter(t => genre === 'All genres' || t.genre === genre)
    .filter(t => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === 'year' ? b.year - a.year : sort === 'mood' ? (a.mood || 'Unanalyzed').localeCompare(b.mood || 'Unanalyzed') : a[sort].localeCompare(b[sort]))
  return (
    <div className="library-view" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div className="library-header" style={{ padding: '32px 20px 20px', borderBottom: '1px solid #1e1b17', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <h1 style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: 28, color: '#e6e1d9', margin: 0, letterSpacing: '-0.02em' }}>
            {title}
          </h1>
          {headerAction}
        </div>
        <div style={{ fontSize: 12, color: '#5a5248', marginTop: 4 }}>
          {visibleTracks.length} of {tracks.length} tracks · {totalTime(visibleTracks)}
        </div>
        {headerContent}
        <div className="library-filters" style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search title, artist, or album…" style={{ flex: 1, maxWidth: 420, background: '#151210', border: '1px solid #2e2a24', borderRadius: 7, color: '#e6e1d9', padding: '9px 12px', outline: 'none' }} />
          <select value={genre} onChange={e => setGenre(e.target.value)} style={{ background: '#151210', border: '1px solid #2e2a24', borderRadius: 7, color: '#a89880', padding: '8px 10px' }}>
            {genres.map(g => <option key={g}>{g}</option>)}
          </select>
          <select value={sort} onChange={e => setSort(e.target.value as 'title' | 'artist' | 'year' | 'mood')} style={{ background: '#151210', border: '1px solid #2e2a24', borderRadius: 7, color: '#a89880', padding: '8px 10px' }}>
            <option value="title">Sort: Title</option><option value="artist">Sort: Artist</option><option value="year">Sort: Newest</option><option value="mood">Sort: Mood</option>
          </select>
        </div>
      </div>

      {/* Column headers */}
      <div className="track-columns" style={{ display: 'grid', gridTemplateColumns: '32px 1fr 180px 60px 82px', gap: 12, padding: '10px 20px', borderBottom: '1px solid #1e1b17', flexShrink: 0 }}>
        <div />
        <div style={{ fontSize: 10, color: '#3d3830', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Title</div>
        <div style={{ fontSize: 10, color: '#3d3830', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Album</div>
        <div style={{ fontSize: 10, color: '#3d3830', letterSpacing: '0.08em', textTransform: 'uppercase', textAlign: 'right' }}>Time</div>
        <div />
      </div>

      {/* Tracks */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {visibleTracks.map((track, i) => (
          <TrackRow
            key={track.id}
            track={track}
            index={i}
            isActive={activeTrack?.id === track.id}
            isPlaying={isPlaying && activeTrack?.id === track.id}
            onPlay={() => onPlay(track, visibleTracks)}
            liked={favorites.includes(track.id)}
            onToggleLike={() => onToggleFavorite(track.id)}
            playlists={playlists}
            onAddToPlaylist={playlistId => onAddToPlaylist(playlistId, track.id)}
          />
        ))}
        {visibleTracks.length === 0 && <div style={{ padding: 36, textAlign: 'center', color: '#5a5248', lineHeight: 1.6 }}>{tracks.length === 0 ? (emptyMessage || 'Your library is empty. Open Settings, add your Synology, and choose the shared folders to scan.') : 'No tracks match these filters.'}</div>}
      </div>
    </div>
  )
}

const MOOD_PRESENTATION: Record<TrackMood, { emoji: string; description: string }> = {
  Happy: { emoji: '☀️', description: 'Bright and upbeat' },
  Calm: { emoji: '🌙', description: 'Soft and relaxing' },
  Focus: { emoji: '🎯', description: 'Steady and low-key' },
  Energetic: { emoji: '⚡', description: 'Fast and lively' },
  Workout: { emoji: '🔥', description: 'High-energy movement' },
  Balanced: { emoji: '✨', description: 'An even musical mix' },
  Romantic: { emoji: '💞', description: 'Warm and affectionate' },
  Sad: { emoji: '🌧️', description: 'Tender and emotional' },
  Chill: { emoji: '🌊', description: 'Easygoing and smooth' },
  Dreamy: { emoji: '☁️', description: 'Airy and atmospheric' },
  Dark: { emoji: '🌑', description: 'Moody and intense' },
  Party: { emoji: '🪩', description: 'Dance-ready and upbeat' },
}

const MOOD_ORDER: TrackMood[] = ['Happy', 'Calm', 'Chill', 'Romantic', 'Dreamy', 'Focus', 'Sad', 'Dark', 'Energetic', 'Party', 'Workout', 'Balanced']

function MoodsView({
  tracks,
  activeTrack,
  isPlaying,
  onPlay,
}: {
  tracks: Track[]
  activeTrack: Track | null
  isPlaying: boolean
  onPlay: (track: Track, queue: Track[]) => void
}) {
  const recognizedMoods = MOOD_ORDER.filter(mood => tracks.some(track => track.mood === mood))

  if (!recognizedMoods.length) {
    return (
      <div className="moods-empty-view">
        <span className="moods-empty-icon"><IconMood size={34} /></span>
        <h1>Your moods will appear here</h1>
        <p>Turn on Background mood analysis in Settings, then play local songs. Every mood the app recognizes will automatically become a playable collection.</p>
      </div>
    )
  }

  return (
    <section className="moods-view">
      <header className="moods-header">
        <span className="section-eyebrow">Your listening moods</span>
        <h1>Moods</h1>
        <p>Tap a mood to start playing it immediately.</p>
      </header>
      <div className="mood-tile-grid" aria-label="Play music by mood">
        {recognizedMoods.map(mood => {
          const moodTracks = tracks.filter(track => track.mood === mood)
          const presentation = MOOD_PRESENTATION[mood]
          const moodIsPlaying = isPlaying && activeTrack?.mood === mood
          return (
            <button
              type="button"
              key={mood}
              className={`mood-tile mood-card-${mood.toLowerCase()} ${moodIsPlaying ? 'is-playing' : ''}`}
              onClick={() => moodTracks[0] && onPlay(moodTracks[0], moodTracks)}
              aria-label={`Play ${mood} mood, ${moodTracks.length} ${moodTracks.length === 1 ? 'track' : 'tracks'}`}
            >
              <span className="mood-tile-top">
                <span className="mood-tile-emoji" aria-hidden="true">{presentation.emoji}</span>
                <span className="mood-tile-play" aria-hidden="true">
                  {moodIsPlaying ? <IconPause size={20} /> : <IconPlay size={20} />}
                </span>
              </span>
              <span className="mood-tile-copy">
                <strong>{mood}</strong>
                <small>{presentation.description}</small>
                <span>{moodIsPlaying ? 'Playing now' : `${moodTracks.length} ${moodTracks.length === 1 ? 'track' : 'tracks'}`}</span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

async function findRadioStations(zip: string) {
  const normalizedZip = zip.replace(/\D/g, '').slice(0, 5)
  if (!/^\d{5}$/.test(normalizedZip)) throw new Error('Enter a five-digit U.S. ZIP code.')

  const result = await lookupRadio(normalizedZip) as RadioSearchResult
  if (!result.found) throw new Error(result.message || 'Local radio could not be loaded.')
  const location = result.location || normalizedZip
  return {
    zip: normalizedZip,
    location,
    stations: (result.stations || []).map(station => radioTrack(station, location)),
  }
}

function RadioZipSearch({
  initialZip,
  onSaved,
  compact = false,
}: {
  initialZip: string
  onSaved: (zip: string, location: string, stations: Track[]) => void
  compact?: boolean
}) {
  const [draftZip, setDraftZip] = useState(initialZip)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [message, setMessage] = useState('')

  async function searchRadio(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatus('loading')
    setMessage('')
    try {
      const result = await findRadioStations(draftZip)
      setDraftZip(result.zip)
      onSaved(result.zip, result.location, result.stations)
      setMessage(result.stations.length
        ? `${result.stations.length} stations saved for ${result.location}.`
        : `No working online streams were found near ${result.location}.`)
      setStatus('idle')
    } catch (cause) {
      setStatus('error')
      setMessage(cause instanceof Error ? cause.message : 'Local radio is temporarily unavailable.')
    }
  }

  return (
    <div className={`radio-zip-search ${compact ? 'compact' : ''}`}>
      <form className="radio-zip-form" onSubmit={searchRadio}>
        <label htmlFor={compact ? 'settings-radio-zip' : 'local-radio-zip'}>U.S. ZIP code</label>
        <div>
          <input
            id={compact ? 'settings-radio-zip' : 'local-radio-zip'}
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={5}
            pattern="[0-9]{5}"
            placeholder="90210"
            value={draftZip}
            onChange={event => setDraftZip(event.target.value.replace(/\D/g, '').slice(0, 5))}
          />
          <button type="submit" disabled={status === 'loading'}>
            {status === 'loading' ? <><span className="radio-search-spinner" />Searching…</> : <><IconRadio size={19} />Search & save</>}
          </button>
        </div>
      </form>
      {message && <p className={`radio-zip-message ${status === 'error' ? 'error' : 'success'}`} role="status">{message}</p>}
    </div>
  )
}

function RadioView({
  zip,
  location,
  stations,
  activeTrack,
  isPlaying,
  onSearchResults,
  onPlay,
}: {
  zip: string
  location: string
  stations: Track[]
  activeTrack: Track | null
  isPlaying: boolean
  onSearchResults: (zip: string, location: string, stations: Track[]) => void
  onPlay: (track: Track, queue: Track[]) => void
}) {
  if (!zip) {
    return (
      <section className="radio-view radio-onboarding-view">
        <header className="radio-header">
          <span className="section-eyebrow">Free live streams near you</span>
          <h1>Local Radio</h1>
          <p>Enter your ZIP code once. Tunestack will save it and turn this page into your personal radio dial.</p>
          <RadioZipSearch initialZip="" onSaved={onSearchResults} />
        </header>
        <div className="radio-empty-state">
          <span><IconRadio size={38} /></span>
          <h2>Find your local stations</h2>
          <p>Only free stations with a currently working online stream will be saved.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="radio-view radio-saved-view">
      <header className="radio-header">
        <span className="section-eyebrow">{location || zip} · Saved</span>
        <h1>Local Radio</h1>
        <p>{stations.length} saved {stations.length === 1 ? 'station' : 'stations'} · Tap a logo to listen</p>
      </header>

      {stations.length ? (
        <div className="radio-logo-grid" aria-label={`Saved radio stations near ${location || zip}`}>
          {stations.map(station => {
            const isActive = activeTrack ? trackLocalKey(activeTrack) === trackLocalKey(station) : false
            return (
              <button
                className={`radio-logo-tile ${isActive ? 'active' : ''}`}
                type="button"
                key={trackLocalKey(station)}
                onClick={() => onPlay(station, stations)}
                aria-label={`${isActive && isPlaying ? 'Pause' : 'Play'} ${station.title}`}
                title={station.title}
              >
                <TrackArtwork track={station} alt="" />
                <span className="radio-logo-play" aria-hidden="true">{isActive && isPlaying ? <IconPause size={22} /> : <IconPlay size={22} />}</span>
                {isActive && <i className="radio-logo-live" aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      ) : (
        <div className="radio-empty-state">
          <span><IconRadio size={38} /></span>
          <h2>No working stations were found</h2>
          <p>Open Settings to enter a different ZIP code and search again.</p>
        </div>
      )}

      <footer className="radio-provider-note">Change the saved ZIP code in Settings.</footer>
    </section>
  )
}

function AlbumCard({ album, tracks, onPlay }: { album: string; tracks: Track[]; onPlay: (track: Track, queue: Track[]) => void }) {
  const [hovered, setHovered] = useState(false)
  const artworkTrack = tracks[0] || { album, artist: 'Unknown artist', title: album, cover: '' }

  return (
    <div className="album-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onPlay(tracks[0], tracks)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPlay(tracks[0], tracks) } }}
      role="button"
      tabIndex={0}
      style={{ cursor: 'pointer' }}
    >
      <div className="album-card-art" style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: '#1a1815', marginBottom: 10 }}>
        <TrackArtwork track={artworkTrack} alt={album} style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 0.3s', transform: hovered ? 'scale(1.04)' : 'scale(1)' }} />
        {hovered && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <button
              onClick={event => { event.stopPropagation(); onPlay(tracks[0], tracks) }}
              style={{ width: 48, height: 48, borderRadius: '50%', background: '#d4924a', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0e0d0c' }}
            >
              <IconPlay size={20} />
            </button>
          </div>
        )}
      </div>
      <div style={{ fontSize: 13, color: '#e6e1d9', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{album}</div>
      <div style={{ fontSize: 11, color: '#5a5248', marginTop: 2 }}>{tracks[0]?.artist} · {tracks.length} tracks</div>
    </div>
  )
}

function AlbumsView({ tracks, onPlay }: { tracks: Track[]; onPlay: (track: Track, queue: Track[]) => void }) {
  const albums = Object.entries(
    tracks.reduce<Record<string, Track[]>>((acc, t) => {
      acc[t.album] = acc[t.album] ? [...acc[t.album], t] : [t]
      return acc
    }, {})
  )

  return (
    <div className="albums-view" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="albums-header" style={{ padding: '32px 28px 20px', borderBottom: '1px solid #1e1b17', flexShrink: 0 }}>
        <h1 style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: 28, color: '#e6e1d9', margin: 0, letterSpacing: '-0.02em' }}>Albums</h1>
        <div style={{ fontSize: 12, color: '#5a5248', marginTop: 4 }}>{albums.length} albums</div>
      </div>
      <div className="albums-scroll" style={{ flex: 1, overflowY: 'auto', padding: 28 }}>
        <div className="albums-grid">
          {albums.map(([album, ts]) => (
            <AlbumCard key={album} album={album} tracks={ts} onPlay={onPlay} />
          ))}
        </div>
      </div>
    </div>
  )
}

type LocalImportState = {
  status: 'idle' | 'importing' | 'done' | 'error'
  total: number
  completed: number
  imported: number
  skipped: number
  message: string
}

const EMPTY_LOCAL_IMPORT: LocalImportState = { status: 'idle', total: 0, completed: 0, imported: 0, skipped: 0, message: '' }

type LocalImportOptions = { album: string; playlistId: string; newPlaylist: string }
type LocalImportSelection =
  | { kind: 'folder' | 'files'; documents: LocalDocument[]; files?: never }
  | { kind: 'folder' | 'files'; files: File[]; documents?: never }

function LocalImportSheet({ state, onFiles, onDocuments, onClose, onReset, albums, playlists }: {
  state: LocalImportState
  onFiles: (files: File[] | null, options: LocalImportOptions) => void
  onDocuments: (documents: LocalDocument[], options: LocalImportOptions) => void
  onClose: () => void
  onReset: () => void
  albums: string[]
  playlists: Playlist[]
}) {
  const [selection, setSelection] = useState<LocalImportSelection | null>(null)
  const [picking, setPicking] = useState(false)
  const [album, setAlbum] = useState('')
  const [newAlbum, setNewAlbum] = useState('')
  const [playlistChoice, setPlaylistChoice] = useState<'none' | 'existing' | 'new'>('none')
  const [playlistId, setPlaylistId] = useState('')
  const [newPlaylist, setNewPlaylist] = useState('')
  const busy = state.status === 'importing'
  const matchingPlaylist = playlists.find(item => item.name.localeCompare(newPlaylist.trim(), undefined, { sensitivity: 'accent' }) === 0)
  const selectedCount = selection?.documents?.length ?? selection?.files?.length ?? 0
  const destination = (): LocalImportOptions => ({
    album: newAlbum.trim() || album,
    playlistId: playlistChoice === 'existing' ? playlistId : playlistChoice === 'new' && matchingPlaylist ? matchingPlaylist.id : '',
    newPlaylist: playlistChoice === 'new' && !matchingPlaylist ? newPlaylist.trim() : '',
  })
  const pickNative = async (kind: 'files' | 'folder') => {
    setPicking(true)
    try {
      const documents = kind === 'folder' ? await pickLocalMusicFolder() : await pickLocalAudioFiles()
      if (documents.length) setSelection({ kind, documents })
    } finally {
      setPicking(false)
    }
  }
  const pickFiles = (kind: 'files' | 'folder') => (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || [])
    if (files.length) setSelection({ kind, files })
    event.currentTarget.value = ''
  }
  const importSelection = () => {
    if (!selection) return
    const options = destination()
    if (selection.documents) onDocuments(selection.documents, options)
    else onFiles(selection.files, options)
  }
  const resetFlow = () => {
    setSelection(null)
    setPlaylistChoice('none')
    setPlaylistId('')
    setNewPlaylist('')
    setAlbum('')
    setNewAlbum('')
    onReset()
  }
  const canImport = Boolean(selection)
    && (playlistChoice !== 'existing' || Boolean(playlistId))
    && (playlistChoice !== 'new' || Boolean(newPlaylist.trim()))

  return (
    <div className="android-sheet-backdrop" role="presentation" onClick={() => { if (!busy) onClose() }}>
      <section className="android-import-sheet" role="dialog" aria-modal="true" aria-labelledby="local-import-title" onClick={event => event.stopPropagation()}>
        <div className="android-sheet-handle" aria-hidden="true" />
        <header>
          <span className="android-sheet-icon"><IconDownload size={22} /></span>
          <span>
            <h2 id="local-import-title">Add music from this device</h2>
            <p>{selection ? 'Choose where the selected music should appear.' : 'Start with a folder or select individual audio files.'}</p>
          </span>
          <button className="android-sheet-close" type="button" onClick={onClose} disabled={busy} aria-label="Close music importer">×</button>
        </header>

        {state.status === 'importing' && (
          <div className="android-import-progress" role="status">
            <div><span style={{ width: `${state.total ? (state.completed / state.total) * 100 : 0}%` }} /></div>
            <strong>Adding music… {state.completed} of {state.total}</strong>
            <small>Keep Melodock open until the links are added.</small>
          </div>
        )}

        {(state.status === 'done' || state.status === 'error') && (
          <div className={`android-import-result ${state.status}`} role="status">
            <IconCheck size={18} />
            <span><strong>{state.message}</strong>{state.skipped > 0 && <small>{state.skipped} unsupported or unreadable files skipped.</small>}</span>
          </div>
        )}

        {!busy && !selection && state.status !== 'done' && (
          <div className="android-import-options">
            {isNativeAndroid() ? (<>
              <button type="button" disabled={picking} onClick={() => void pickNative('folder')}><span className="android-option-icon"><IconFolder size={26} /></span><span><strong>Choose Folder</strong><small>Link every supported song in one folder</small></span><b aria-hidden="true">›</b></button>
              <button type="button" disabled={picking} onClick={() => void pickNative('files')}><span className="android-option-icon"><IconMusic size={26} /></span><span><strong>Choose Files</strong><small>Pick one or more individual songs</small></span><b aria-hidden="true">›</b></button>
            </>) : (<>
              <label><input type="file" accept="audio/*,.flac,.m4a,.ogg,.opus,.wav,.aiff,.wma" multiple hidden ref={element => { if (element) { element.setAttribute('webkitdirectory', ''); element.setAttribute('directory', '') } }} onChange={pickFiles('folder')} /><span className="android-option-icon"><IconFolder size={26} /></span><span><strong>Choose Folder</strong><small>Select all supported songs inside it</small></span><b aria-hidden="true">›</b></label>
              <label><input type="file" accept="audio/*,.flac,.m4a,.ogg,.opus,.wav,.aiff,.wma" multiple hidden onChange={pickFiles('files')} /><span className="android-option-icon"><IconMusic size={26} /></span><span><strong>Choose Files</strong><small>Pick one or more individual songs</small></span><b aria-hidden="true">›</b></label>
            </>)}
          </div>
        )}

        {!busy && selection && state.status !== 'done' && (
          <div className="android-import-organize">
            <div className="android-selection-summary"><span className="android-option-icon">{selection.kind === 'folder' ? <IconFolder size={23} /> : <IconMusic size={23} />}</span><span><strong>{selectedCount} {selectedCount === 1 ? 'song' : 'songs'} selected</strong><small>{selection.kind === 'folder' ? 'Folder linked and ready' : 'Files linked and ready'}</small></span><button type="button" onClick={() => setSelection(null)}>Change</button></div>
            <fieldset className="android-playlist-choice">
              <legend>Add these songs to a playlist?</legend>
              <label className={playlistChoice === 'existing' ? 'selected' : ''}><input type="radio" name="playlist-choice" checked={playlistChoice === 'existing'} onChange={() => setPlaylistChoice('existing')} /><span><strong>Existing playlist</strong><small>Add songs without removing anything already there</small></span></label>
              {playlistChoice === 'existing' && <select aria-label="Choose existing playlist" value={playlistId} onChange={event => setPlaylistId(event.target.value)}><option value="">Choose a playlist…</option>{playlists.map(item => <option key={item.id} value={item.id}>{item.name} ({item.trackIds.length})</option>)}</select>}
              <label className={playlistChoice === 'new' ? 'selected' : ''}><input type="radio" name="playlist-choice" checked={playlistChoice === 'new'} onChange={() => setPlaylistChoice('new')} /><span><strong>New playlist</strong><small>Create a playlist for these songs</small></span></label>
              {playlistChoice === 'new' && <input aria-label="New playlist name" autoFocus value={newPlaylist} onChange={event => setNewPlaylist(event.target.value)} placeholder="Playlist name" />}
              {playlistChoice === 'new' && matchingPlaylist && <div className="android-playlist-match"><IconCheck size={17} /><span><strong>“{matchingPlaylist.name}” already exists</strong><small>Melodock will add these songs to that playlist. It will not replace it.</small></span></div>}
              <label className={playlistChoice === 'none' ? 'selected' : ''}><input type="radio" name="playlist-choice" checked={playlistChoice === 'none'} onChange={() => setPlaylistChoice('none')} /><span><strong>No playlist</strong><small>Add songs only to Local Music</small></span></label>
            </fieldset>
            <details className="android-album-options"><summary>Album options</summary><div><label><span>Use existing album</span><select value={album} onChange={event => { setAlbum(event.target.value); setNewAlbum('') }}><option value="">Keep album information from each song</option>{albums.map(name => <option key={name} value={name}>{name}</option>)}</select></label><label><span>Or use a new album name</span><input value={newAlbum} onChange={event => { setNewAlbum(event.target.value); if (event.target.value) setAlbum('') }} placeholder="Optional album name" /></label></div></details>
            <button className="android-import-confirm" type="button" disabled={!canImport} onClick={importSelection}>Add {selectedCount} {selectedCount === 1 ? 'song' : 'songs'}</button>
          </div>
        )}
        <div className="android-import-note">{isNativeAndroid() ? 'No copies are created. Melodock stores read-only links and plays music directly from its original folder.' : 'Browser imports may use private browser storage. The Android app uses no-copy folder references.'}</div>
        {state.status === 'done' && <button className="android-import-more" type="button" onClick={resetFlow}>Add more music</button>}
      </section>
    </div>
  )
}

type DownloadState = 'idle' | 'downloading' | 'done' | 'error'

type LyricsResult = {
  found: boolean
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
  message?: string
  provider?: 'LRCLIB' | 'Lyrics.ovh'
  sourceUrl?: string
  trackName?: string
  artistName?: string
  albumName?: string
}

type TimedLyricLine = { time: number; text: string }

function parseSyncedLyrics(value?: string | null) {
  if (!value) return []
  const lines: TimedLyricLine[] = []
  for (const rawLine of value.split(/\r?\n/)) {
    const timestamps = Array.from(rawLine.matchAll(/\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/g))
    const text = rawLine.replace(/\[[^\]]+\]/g, '').trim()
    for (const timestamp of timestamps) {
      lines.push({ time: Number(timestamp[1]) * 60 + Number(timestamp[2]), text })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

function trackLightPalette(track: Track): [string, string, string] {
  const value = `${track.id}|${track.sourcePath || ''}|${track.title}|${track.artist}`
  let seed = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    seed ^= value.charCodeAt(index)
    seed = Math.imul(seed, 16777619)
  }
  const firstHue = Math.abs(seed) % 360
  const secondHue = (firstHue + 82 + ((seed >>> 8) % 67)) % 360
  const thirdHue = (firstHue + 188 + ((seed >>> 16) % 83)) % 360
  return [
    `hsl(${firstHue}, 88%, 60%)`,
    `hsl(${secondHue}, 84%, 58%)`,
    `hsl(${thirdHue}, 90%, 62%)`,
  ]
}

function NowPlayingView({
  track,
  isPlaying,
  onToggle,
  onNext,
  onPrev,
  progress,
  duration,
  onSeek,
  shuffle,
  onToggleShuffle,
  repeat,
  onToggleRepeat,
  liked,
  onToggleFavorite,
  queue,
  onPlayFromQueue,
  playlists,
  onAddToPlaylist,
  onCreatePlaylist,
  playingFromDevice,
  localAvailable,
  activeSource,
  onDownload,
  onReconnect,
  downloadState,
  playbackStatus,
  playbackError,
  lightColorMode,
  onSaveMetadata,
  updateMetadataFromLyrics,
  onApplyLyricsMetadata,
}: {
  track: Track | null
  isPlaying: boolean
  onToggle: () => void
  onNext: () => void
  onPrev: () => void
  progress: number
  duration: number
  onSeek: (time: number) => void
  shuffle: boolean
  onToggleShuffle: () => void
  repeat: boolean
  onToggleRepeat: () => void
  liked: boolean
  onToggleFavorite: () => void
  queue: Track[]
  onPlayFromQueue: (track: Track) => void
  playlists: Playlist[]
  onAddToPlaylist: (playlistId: string, trackId: number) => void
  onCreatePlaylist: (trackId: number) => void
  playingFromDevice: NasDevice | null
  localAvailable: boolean
  activeSource: PlaybackSource | null
  onDownload: () => void
  onReconnect: () => void
  downloadState: DownloadState
  playbackStatus: 'idle' | 'loading' | 'ready' | 'error'
  playbackError: string
  lightColorMode: LightColorMode
  onSaveMetadata: (title: string, artist: string) => void
  updateMetadataFromLyrics: boolean
  onApplyLyricsMetadata: (metadata: Pick<Track, 'title' | 'artist' | 'album'>) => void
}) {
  const [queueOpen, setQueueOpen] = useState(false)
  const [playlistOpen, setPlaylistOpen] = useState(false)
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [lyricsStatus, setLyricsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null)
  const [lyricsTitle, setLyricsTitle] = useState('')
  const [lyricsArtist, setLyricsArtist] = useState('')
  const lyricsContentRef = useRef<HTMLDivElement | null>(null)
  const lyricsRequestRef = useRef<AbortController | null>(null)
  const lyricsAutoReturnRef = useRef('')
  const lyricsHistoryRef = useRef(false)
  const trackKey = track ? trackLocalKey(track) : ''
  const isLiveRadio = track?.origin === 'radio'

  const openLyrics = useCallback(() => {
    if (isLiveRadio) return
    if (!lyricsHistoryRef.current) {
      const currentState = window.history.state && typeof window.history.state === 'object' ? window.history.state : {}
      window.history.pushState({ ...currentState, tunestackOverlay: 'lyrics' }, '')
      lyricsHistoryRef.current = true
    }
    setLyricsOpen(true)
  }, [isLiveRadio])

  const closeLyrics = useCallback(() => {
    setLyricsOpen(false)
    const ownsHistoryEntry = lyricsHistoryRef.current
    lyricsHistoryRef.current = false
    if (ownsHistoryEntry && window.history.state?.tunestackOverlay === 'lyrics') window.history.back()
  }, [])

  const runLyricsLookup = useCallback((title: string, artist: string, album: string, durationHint: number, offerMetadataUpdate = false) => {
    lyricsRequestRef.current?.abort()
    const controller = new AbortController()
    lyricsRequestRef.current = controller
    setLyricsStatus('loading')
    setLyrics(null)
    lookupLyrics({ title, artist, album, duration: Math.round(durationHint || 0) })
      .then(async response => {
        if (controller.signal.aborted) return
        const payload = response as LyricsResult
        setLyrics(payload)
        setLyricsStatus(payload.found ? 'ready' : 'error')
        if (payload.found && offerMetadataUpdate && updateMetadataFromLyrics && payload.trackName && payload.artistName && track) {
          const nextMetadata = {
            title: payload.trackName,
            artist: payload.artistName,
            album: payload.albumName || track.album,
          }
          const details = [nextMetadata.title, nextMetadata.artist, nextMetadata.album].filter(Boolean).join(' · ')
          if (window.confirm(`Lyrics matched ${details}. Update this song’s title, artist, and album? Existing artwork will be kept.`)) onApplyLyricsMetadata(nextMetadata)
        }
      })
      .catch(cause => {
        if (cause instanceof Error && cause.name === 'AbortError') return
        setLyrics({ found: false, message: cause instanceof Error ? cause.message : 'Lyrics are temporarily unavailable.' })
        setLyricsStatus('error')
      })
  }, [onApplyLyricsMetadata, track, updateMetadataFromLyrics])

  useEffect(() => {
    closeLyrics()
  }, [closeLyrics, trackKey])

  useEffect(() => {
    const handleHistoryBack = () => {
      if (!lyricsHistoryRef.current) return
      lyricsHistoryRef.current = false
      setLyricsOpen(false)
    }
    window.addEventListener('popstate', handleHistoryBack)
    return () => window.removeEventListener('popstate', handleHistoryBack)
  }, [])

  useEffect(() => {
    if (!lyricsOpen) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeLyrics()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [closeLyrics, lyricsOpen])

  useEffect(() => {
    if (!track) return
    if (track.origin === 'radio') {
      lyricsRequestRef.current?.abort()
      const timer = window.setTimeout(() => {
        setLyrics(null)
        setLyricsStatus('idle')
        setLyricsTitle(track.title)
        setLyricsArtist(track.artist)
      }, 0)
      return () => window.clearTimeout(timer)
    }
    const title = track.title
    const artist = lyricsSearchArtist(track.artist)
    const album = track.album
    const durationHint = track.duration || 0
    const timer = window.setTimeout(() => {
      setLyricsTitle(title)
      setLyricsArtist(artist)
      runLyricsLookup(title, artist, album, durationHint)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      lyricsRequestRef.current?.abort()
    }
  }, [track, trackKey, runLyricsLookup])

  const syncedLines = parseSyncedLyrics(lyrics?.syncedLyrics)
  const activeLyricIndex = syncedLines.reduce((active, line, index) => line.time <= progress + 0.15 ? index : active, -1)
  const activeLyricText = activeLyricIndex >= 0 ? syncedLines[activeLyricIndex]?.text.trim() || '' : ''
  const previousLyricText = activeLyricIndex > 0 ? syncedLines[activeLyricIndex - 1]?.text.trim() || '' : ''
  const nextLyricText = activeLyricIndex >= 0 ? syncedLines[activeLyricIndex + 1]?.text.trim() || '' : ''

  useEffect(() => {
    if (!lyricsOpen || activeLyricIndex < 0) return
    const frame = window.requestAnimationFrame(() => {
      const container = lyricsContentRef.current
      const activeLine = container?.querySelector<HTMLElement>('.synced-lyrics p.active')
      if (!container || !activeLine) return
      const containerRect = container.getBoundingClientRect()
      const lineRect = activeLine.getBoundingClientRect()
      const centeredTop = container.scrollTop
        + lineRect.top
        - containerRect.top
        - (container.clientHeight - lineRect.height) / 2
      const maximumTop = Math.max(0, container.scrollHeight - container.clientHeight)
      container.scrollTo({
        top: Math.min(maximumTop, Math.max(0, centeredTop)),
        behavior: 'smooth',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [lyricsOpen, activeLyricIndex])

  useEffect(() => {
    if (!lyricsOpen || !isPlaying || lyricsStatus !== 'ready' || activeLyricIndex < 0 || !activeLyricText || lyricsAutoReturnRef.current === trackKey) return
    lyricsAutoReturnRef.current = trackKey
    const timer = window.setTimeout(closeLyrics, 650)
    return () => window.clearTimeout(timer)
  }, [activeLyricIndex, activeLyricText, closeLyrics, isPlaying, lyricsOpen, lyricsStatus, trackKey])

  if (!track) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#3d3830' }}>
          <IconMusic size={48} />
          <div style={{ marginTop: 12, fontSize: 14 }}>Nothing playing</div>
        </div>
      </div>
    )
  }

  const lightPalette = trackLightPalette(track)
  const randomLightStyle = {
    '--track-light-one': lightPalette[0],
    '--track-light-two': lightPalette[1],
    '--track-light-three': lightPalette[2],
  } as CSSProperties

  return (
    <div className="now-playing-view immersive-now-playing">
      <TrackArtwork className="immersive-background" track={track} />
      <div className="immersive-shade" aria-hidden="true" />
      <div
        className={`immersive-screen-lights mode-${lightColorMode} ${isPlaying && playbackStatus === 'ready' ? 'playing' : ''}`}
        style={lightColorMode === 'random' ? randomLightStyle : undefined}
        aria-hidden="true"
      >
        {lightColorMode === 'artwork' && hasMeaningfulArtwork(track.cover) ? (
          <><img src={track.cover} alt="" /><img src={track.cover} alt="" /><img src={track.cover} alt="" /></>
        ) : <><i /><i /><i /></>}
      </div>

      <div className="immersive-player-content">
        <div className="immersive-top-actions">
          <button type="button" onClick={() => setQueueOpen(true)} aria-label="Show current queue"><IconQueue size={29} /></button>
          <button className={liked ? 'active' : ''} type="button" onClick={onToggleFavorite} aria-label={liked ? 'Remove from favorites' : 'Add to favorites'}><IconHeart size={31} filled={liked} /></button>
          <button type="button" onClick={() => setPlaylistOpen(true)} aria-label="Add to playlist"><IconPlus size={31} /></button>
        </div>

        <button
          className={`immersive-record ${isPlaying && playbackStatus === 'ready' ? 'playing' : ''}`}
          type="button"
          onClick={openLyrics}
          disabled={isLiveRadio}
          aria-label={isLiveRadio ? `${track.title} live station artwork` : 'Show full lyrics'}
        >
          <TrackArtwork track={track} alt={track.album} />
          <span aria-hidden="true" />
          <small className="immersive-record-lyric-label">{isLiveRadio ? 'Live radio' : lyricsStatus === 'loading' ? 'Finding lyrics…' : syncedLines.length ? 'Lyrics ready' : 'Lyrics'}</small>
        </button>

        <div className="immersive-track-info">
          <strong>{cleanTrackTitle(track.title)}</strong>
          <span>{track.artist}{track.album ? ` · ${track.album}` : ''}</span>
        </div>

        {isLiveRadio ? (
          <div className="immersive-live-radio">
            <span><i />LIVE RADIO</span>
            <strong>{track.genre || 'Local station'}</strong>
            <small>
              {typeof track.radioDistanceMiles === 'number' ? `${track.radioDistanceMiles} miles away` : 'Near your ZIP code'}
              {track.radioCodec ? ` · ${track.radioCodec}` : ''}
              {track.radioBitrate ? ` · ${track.radioBitrate} kbps` : ''}
            </small>
          </div>
        ) : (
          <>
            <button
              className={`immersive-live-lyric ${activeLyricText ? 'visible' : ''}`}
              type="button"
              onClick={openLyrics}
              aria-label={activeLyricText ? `Current lyric: ${activeLyricText}. Open full lyrics` : 'Open lyrics'}
              aria-hidden={!activeLyricText}
              tabIndex={activeLyricText ? 0 : -1}
            >
              {activeLyricText && (
                <>
                  <span className="immersive-lyric-context previous" dir="auto">{previousLyricText || '\u00a0'}</span>
                  <strong className="immersive-lyric-current" key={`${trackKey}-${activeLyricIndex}`} dir="auto">{activeLyricText}</strong>
                  <span className="immersive-lyric-context next" dir="auto">{nextLyricText || '\u00a0'}</span>
                </>
              )}
            </button>

            <div className="immersive-progress">
              <div>
                <input type="range" min={0} max={duration || 1} value={Math.min(progress, duration || 1)} onChange={event => onSeek(Number(event.target.value))} aria-label="Track position" />
                <span style={{ width: `${duration ? Math.min(100, (progress / duration) * 100) : 0}%` }} />
              </div>
              <p><span>{fmt(progress)}</span><span>{duration > 0 ? fmt(duration) : '—:—'}</span></p>
            </div>
          </>
        )}

        <div className="immersive-playback-controls">
          <button className={shuffle ? 'active' : ''} type="button" onClick={onToggleShuffle} aria-label={shuffle ? 'Turn shuffle off' : 'Turn shuffle on'}><IconShuffle active={shuffle} /></button>
          <button type="button" onClick={onPrev} aria-label="Previous track"><IconSkipPrev size={31} /></button>
          <button className="immersive-main-play" type="button" onClick={onToggle} aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? <IconPause size={42} /> : <IconPlay size={42} />}</button>
          <button type="button" onClick={onNext} aria-label="Next track"><IconSkipNext size={31} /></button>
          <button className={repeat ? 'active' : ''} type="button" onClick={onToggleRepeat} aria-label={repeat ? 'Turn repeat off' : 'Repeat this track'}><IconRepeat active={repeat} /></button>
        </div>

        {activeSource === 'synology' && playingFromDevice && (
          <div className="immersive-synology-source">
            <IconCloud size={16} />
            <span>{playingFromDevice.name}</span>
            {!localAvailable ? (
              <button type="button" onClick={onDownload} disabled={downloadState === 'downloading'}>
                <IconDownload size={14} /> {downloadState === 'downloading' ? 'Saving…' : downloadState === 'error' ? 'Retry' : 'Save offline'}
              </button>
            ) : <small><IconCheck size={13} /> Saved offline</small>}
          </div>
        )}

        {playbackError && playingFromDevice && !playingFromDevice.sid && !localAvailable ? (
          <div className="immersive-reconnect-card">
            <IconServer size={20} />
            <span><strong>Reconnect Synology</strong><small>Your saved library is still here. Reconnect {playingFromDevice.name} to stream this track.</small></span>
            <button type="button" onClick={onReconnect}>Open settings</button>
          </div>
        ) : playbackError ? <div className="immersive-playback-error">{playbackError}</div> : null}
      </div>

      {queueOpen && (
        <div className="immersive-sheet-backdrop" role="presentation" onClick={() => setQueueOpen(false)}>
          <section className="immersive-action-sheet queue-sheet" role="dialog" aria-modal="true" aria-label="Current queue" onClick={event => event.stopPropagation()}>
            <header><span><IconQueue size={22} /><strong>Up Next</strong><small>{queue.length} {queue.length === 1 ? 'track' : 'tracks'}</small></span><button type="button" onClick={() => setQueueOpen(false)} aria-label="Close queue">×</button></header>
            <div>
              {queue.map((queuedTrack, index) => (
                <button className={queuedTrack.id === track.id && queuedTrack.sourcePath === track.sourcePath ? 'active' : ''} type="button" key={`${queuedTrack.id}-${queuedTrack.sourcePath || index}`} onClick={() => { onPlayFromQueue(queuedTrack); setQueueOpen(false) }}>
                  <span>{index + 1}</span><TrackArtwork track={queuedTrack} /><b>{queuedTrack.title}<small>{queuedTrack.artist}</small></b>{queuedTrack.id === track.id && queuedTrack.sourcePath === track.sourcePath && <i>Playing</i>}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {playlistOpen && (
        <div className="immersive-sheet-backdrop" role="presentation" onClick={() => setPlaylistOpen(false)}>
          <section className="immersive-action-sheet playlist-sheet" role="dialog" aria-modal="true" aria-label="Add track to playlist" onClick={event => event.stopPropagation()}>
            <header><span><IconPlus size={22} /><strong>Add to playlist</strong><small>{track.title}</small></span><button type="button" onClick={() => setPlaylistOpen(false)} aria-label="Close playlist picker">×</button></header>
            <div>
              {playlists.map(playlist => <button type="button" key={playlist.id} onClick={() => { onAddToPlaylist(playlist.id, track.id); setPlaylistOpen(false) }}><span><IconList size={18} /></span><b>{playlist.name}<small>{playlist.trackIds.length} {playlist.trackIds.length === 1 ? 'track' : 'tracks'}</small></b></button>)}
              <button className="create-playlist-action" type="button" onClick={() => { onCreatePlaylist(track.id); setPlaylistOpen(false) }}><span><IconPlus size={18} /></span><b>Create new playlist<small>Start with this song</small></b></button>
            </div>
          </section>
        </div>
      )}

      {lyricsOpen && !isLiveRadio && (
        <section className="lyrics-sheet" role="dialog" aria-modal="true" aria-label={`Lyrics for ${track.title}`}>
          <header>
            <button className="lyrics-back-button" type="button" onClick={closeLyrics} aria-label="Back to Now Playing">
              <span aria-hidden="true">‹</span>
              <b>Now Playing</b>
            </button>
            <div>
              <span>Lyrics</span>
              <strong>{track.title}</strong>
              <small>{track.artist}</small>
            </div>
            <button className="lyrics-close-button" type="button" onClick={closeLyrics} aria-label="Close lyrics and return to Now Playing">×</button>
          </header>
          <form className="lyrics-search-form" onSubmit={event => {
            event.preventDefault()
            const title = lyricsTitle.trim()
            const artist = lyricsArtist.trim()
            onSaveMetadata(title, artist)
            runLyricsLookup(title, artist, track.album, duration || track.duration || 0, true)
          }}>
            <label>Title<input value={lyricsTitle} onChange={event => setLyricsTitle(event.target.value)} /></label>
            <label>Artist<input value={lyricsArtist} onChange={event => setLyricsArtist(event.target.value)} /></label>
            <button type="submit" disabled={!lyricsTitle.trim() || lyricsStatus === 'loading'}>{lyricsStatus === 'loading' ? 'Searching…' : 'Save & search'}</button>
          </form>
          <div className="lyrics-content" ref={lyricsContentRef}>
            {lyricsStatus === 'loading' && <div className="lyrics-message"><span className="lyrics-loading-bars"><i /><i /><i /></span>Finding lyrics…</div>}
            {lyricsStatus !== 'loading' && lyrics?.instrumental && <div className="lyrics-message">This track is marked as instrumental.</div>}
            {lyricsStatus !== 'loading' && !lyrics?.instrumental && syncedLines.length > 0 && (
              <div className="synced-lyrics">
                {syncedLines.map((line, index) => <p key={`${line.time}-${index}`} className={index === activeLyricIndex ? 'active' : index < activeLyricIndex ? 'passed' : ''}>{line.text || '♪'}</p>)}
              </div>
            )}
            {lyricsStatus !== 'loading' && !lyrics?.instrumental && syncedLines.length === 0 && lyrics?.plainLyrics && (
              <div className="plain-lyrics">{lyrics.plainLyrics}</div>
            )}
            {lyricsStatus === 'error' && !lyrics?.plainLyrics && <div className="lyrics-message">{lyrics?.message || 'No lyrics were found for this track.'}</div>}
          </div>
          <footer>
            {lyrics?.provider === 'Lyrics.ovh' ? <>Lyrics provided by <a href="https://lyricsovh.docs.apiary.io/" target="_blank" rel="noreferrer">Lyrics.ovh</a></> : <>Lyrics provided by <a href="https://lrclib.net" target="_blank" rel="noreferrer">LRCLIB</a></>}
            <span>{updateMetadataFromLyrics ? 'A reliable manual lyrics search can offer metadata updates while keeping existing artwork.' : 'Metadata updates from lyrics matches are off in Settings.'}</span>
          </footer>
        </section>
      )}
    </div>
  )
}

// ─── Settings ────────────────────────────────────────────────────────────────

const NAV_LABELS: Record<NavView, string> = {
  local: 'Local files',
  synology: 'Synology',
  radio: 'Local radio',
  favorites: 'Favorites',
  moods: 'Moods',
  library: 'All music',
  albums: 'Albums',
  nowplaying: 'Now playing',
  settings: 'Settings',
}

function SettingsView({
  settings,
  isPro,
  onChange,
  devices,
  onAddSource,
  onReconnectSource,
  onRemoveSource,
  localTracks,
  deviceProfile,
  moodAnalysis,
  radioZip,
  radioLocation,
  radioStationCount,
  onRadioSearchResults,
}: {
  settings: PlayerSettings
  isPro: boolean
  onChange: (settings: PlayerSettings) => void
  devices: NasDevice[]
  onAddSource: (device: NasDevice, tracks: Track[]) => void
  onReconnectSource: (device: NasDevice) => void
  onRemoveSource: (id: string) => void
  localTracks: Track[]
  deviceProfile: DeviceProfile
  moodAnalysis: MoodAnalysisState
  radioZip: string
  radioLocation: string
  radioStationCount: number
  onRadioSearchResults: (zip: string, location: string, stations: Track[]) => void
}) {
  const analyzedMoodCount = localTracks.filter(track => track.mood && track.moodModelVersion === MOOD_MODEL_VERSION).length
  const retryMoodCount = localTracks.filter(track => track.moodModelVersion !== MOOD_MODEL_VERSION && track.moodAnalysisError).length
  const pendingMoodCount = Math.max(0, localTracks.length - analyzedMoodCount - retryMoodCount)
  const linkedTrackCount = localTracks.filter(track => Boolean(track.documentUri)).length
  const downloadedTrackCount = localTracks.length - linkedTrackCount

  function moveNav(index: number, direction: -1 | 1) {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= settings.navOrder.length) return
    const order = [...settings.navOrder]
    const [item] = order.splice(index, 1)
    order.splice(nextIndex, 0, item)
    onChange({ ...settings, navOrder: order })
  }

  return (
    <div className="settings-view" style={{ flex: 1, overflowY: 'auto', padding: 28 }}>
      <div className="settings-heading">
        <div className="section-eyebrow">Personalize</div>
        <h1>Player Settings</h1>
        <p>Customize the player and put the sections you use most at the top.</p>
      </div>

      <div className="settings-grid">
        <section className="settings-panel">
          <div className="section-eyebrow">Appearance · Pro</div>
          <h2>Theme</h2>
          <div className="setting-choice-grid">
            <button className={settings.theme === 'apple-dark' ? 'selected' : ''} onClick={() => onChange({ ...settings, theme: 'apple-dark' })}>
              <strong>Midnight</strong><span>Deep charcoal surfaces with vibrant artwork and controls</span>
            </button>
            <button className={settings.theme === 'apple-light' ? 'selected' : ''} disabled={!isPro} onClick={() => isPro && onChange({ ...settings, theme: 'apple-light' })}>
              <strong>Daylight</strong><span>Bright, airy surfaces inspired by a native music library</span>
            </button>
          </div>

          <h2>Display color</h2>
          <div className="accent-choices">
            {(['pink', 'red', 'orange', 'purple', 'blue', 'teal', 'green'] as const).map(accent => (
              <button key={accent} className={`${accent} ${settings.accent === accent ? 'selected' : ''}`} disabled={!isPro} onClick={() => isPro && onChange({ ...settings, accent })}>{accent}</button>
            ))}
          </div>

          <h2>Now Playing light colors</h2>
          <div className="setting-choice-grid">
            <button className={settings.lightColorMode === 'random' ? 'selected' : ''} onClick={() => onChange({ ...settings, lightColorMode: 'random' })}>
              <strong>Random for every song</strong><span>A fresh three-color combination based on the current track</span>
            </button>
            <button className={settings.lightColorMode === 'artwork' ? 'selected' : ''} disabled={!isPro} onClick={() => isPro && onChange({ ...settings, lightColorMode: 'artwork' })}>
              <strong>Use album artwork</strong><span>Build the moving lights from the colors in the current cover</span>
            </button>
          </div>

          <h2>Density</h2>
          <div className="inline-setting">
            <button className={settings.density === 'compact' ? 'selected' : ''} disabled={!isPro} onClick={() => isPro && onChange({ ...settings, density: 'compact' })}>Compact</button>
            <button className={settings.density === 'comfortable' ? 'selected' : ''} onClick={() => onChange({ ...settings, density: 'comfortable' })}>Comfortable</button>
          </div>
        </section>

        <section className="settings-panel">
          <div className="section-eyebrow">Playback</div>
          <h2>Source priority</h2>
          <label className="settings-toggle">
            <input type="checkbox" checked={settings.preferLocal} onChange={event => onChange({ ...settings, preferLocal: event.target.checked })} />
            <span><strong>Prefer downloaded local copies</strong><small>When both copies exist, play Local before Synology.</small></span>
          </label>

          <div className="source-priority-preview">
            <span className={settings.preferLocal ? 'active' : ''}>1 LOCAL</span>
            <b>→</b>
            <span className={!settings.preferLocal ? 'active' : ''}>2 SYNOLOGY</span>
          </div>
        </section>

        <section className="settings-panel">
          <div className="section-eyebrow">Storage</div>
          <h2>Your music is not duplicated</h2>
          <p><strong>{linkedTrackCount}</strong> tracks are linked from their original Android folders. Melodock stores only their read-only addresses and metadata.</p>
          <p><strong>{downloadedTrackCount}</strong> tracks are private offline downloads created only through an explicit “Save offline” action.</p>
        </section>

        <section className="settings-panel settings-wide radio-settings-panel">
          <div className="section-eyebrow">Local Radio</div>
          <h2>Change your saved ZIP code</h2>
          <p>Search a new area here. The Radio tab will replace its saved station icons with the new results.</p>
          <div className="radio-settings-current">
            <span><IconRadio size={22} /></span>
            <span>
              <strong>{radioLocation || (radioZip ? `ZIP ${radioZip}` : 'No ZIP code saved')}</strong>
              <small>{radioZip ? `${radioStationCount} saved ${radioStationCount === 1 ? 'station' : 'stations'} · ZIP ${radioZip}` : 'Enter a ZIP code below to create your Radio tab.'}</small>
            </span>
          </div>
          <RadioZipSearch initialZip={radioZip} onSaved={onRadioSearchResults} compact />
        </section>

        <section className="settings-panel nav-priority-panel">
          <div className="section-eyebrow">Navigation</div>
          <h2>Section order</h2>
          <p>Use the arrows to set the sidebar and mobile navigation priority.</p>
          <div className="nav-order-list">
            {settings.navOrder.map((item, index) => (
              <div key={item} className="nav-order-row">
                <span className="order-number">{String(index + 1).padStart(2, '0')}</span>
                <span>{NAV_LABELS[item]}</span>
                <div>
                  <button aria-label={`Move ${NAV_LABELS[item]} up`} disabled={index === 0} onClick={() => moveNav(index, -1)}>▲</button>
                  <button aria-label={`Move ${NAV_LABELS[item]} down`} disabled={index === settings.navOrder.length - 1} onClick={() => moveNav(index, 1)}>▼</button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="settings-panel mood-lab-panel">
          <div className="section-eyebrow">Local Mood Lab</div>
          <h2>Analyze offline music on this device</h2>
          <div className="device-profile-card" aria-label="Detected platform">
            <span className={`device-profile-badge ${deviceProfile.deviceClass}`}>{deviceProfile.deviceClass}</span>
            <span>
              <strong>{deviceProfile.ready ? `${deviceProfile.os} · ${deviceProfile.browser} · ${deviceProfile.appMode}` : 'Detecting this device…'}</strong>
              <small>Extended multi-part playback analysis{deviceProfile.memoryGb ? ` · ${deviceProfile.memoryGb} GB reported memory` : ''}</small>
            </span>
          </div>
          <label className={`background-analysis-card ${settings.autoAnalyzeLocal ? 'enabled' : ''}`}>
            <input className="background-analysis-input" type="checkbox" disabled={!isPro} checked={isPro && settings.autoAnalyzeLocal} onChange={event => isPro && onChange({ ...settings, autoAnalyzeLocal: event.target.checked })} />
            <span className="background-analysis-icon"><IconMusic size={24} /></span>
            <span className="background-analysis-copy">
              <strong>Background mood analysis</strong>
              <small>Listen to the beginning, middle, and ending, then combine the beat with available lyric cues. Skipping cancels unfinished work.</small>
            </span>
            <span className="android-switch" aria-hidden="true"><i /></span>
          </label>
          <p>Audio stays on this device. Lyrics are checked through the same online lyric search used by Now Playing. Synology-only tracks are ignored until saved locally.</p>
          <div className="mood-summary">
            <strong>{analyzedMoodCount}</strong>
            <span>of {localTracks.length} local tracks analyzed{retryMoodCount ? ` · ${retryMoodCount} will retry when played` : ''}{pendingMoodCount ? ` · ${pendingMoodCount} remaining` : ''}</span>
          </div>
          {moodAnalysis.status === 'running' && (
            <div className="mood-progress" role="status">
              <span style={{ width: `${moodAnalysis.total ? (moodAnalysis.completed / moodAnalysis.total) * 100 : 0}%` }} />
              <small>{moodAnalysis.message || 'Analyzing the current track…'}</small>
            </div>
          )}
          {moodAnalysis.message && moodAnalysis.status !== 'running' && <div className={`mood-message ${moodAnalysis.status}`}>{moodAnalysis.message}</div>}
          <div className={`auto-analysis-state ${settings.autoAnalyzeLocal ? 'enabled' : ''}`}>
            <span aria-hidden="true" />
            {settings.autoAnalyzeLocal ? 'Automatic playback analysis is enabled' : 'Automatic playback analysis is off'}
          </div>
        </section>

        <section className="settings-panel lyrics-metadata-panel">
          <div className="section-eyebrow">Lyrics &amp; metadata</div>
          <h2>Offer metadata updates after a lyrics search</h2>
          <label className={`background-analysis-card ${settings.updateMetadataFromLyrics ? 'enabled' : ''}`}>
            <input className="background-analysis-input" type="checkbox" disabled={!isPro} checked={isPro && settings.updateMetadataFromLyrics} onChange={event => isPro && onChange({ ...settings, updateMetadataFromLyrics: event.target.checked })} />
            <span className="background-analysis-icon"><IconMusic size={24} /></span>
            <span className="background-analysis-copy"><strong>Metadata suggestions</strong><small>After you manually search for lyrics and a reliable match is found, ask before updating title, artist, and album. Existing artwork is always kept.</small></span>
            <span className="android-switch" aria-hidden="true"><i /></span>
          </label>
          <p>This never runs or asks just because a song starts playing. It is off by default and always requires your approval.</p>
        </section>

        <section className="settings-panel settings-wide source-settings-panel">
          <SourcesView devices={devices} onAdd={onAddSource} onReconnect={onReconnectSource} onRemove={onRemoveSource} embedded />
        </section>
      </div>

      <button className="reset-settings" onClick={() => onChange(DEFAULT_SETTINGS)}>Reset player settings</button>
    </div>
  )
}

// ─── Player Bar ──────────────────────────────────────────────────────────────

function SleepTimerSheet({ remainingSeconds, onSet, onCancel, onClose }: {
  remainingSeconds: number
  onSet: (minutes: number) => void
  onCancel: () => void
  onClose: () => void
}) {
  const [customValue, setCustomValue] = useState('90')
  const [customUnit, setCustomUnit] = useState<'minutes' | 'hours'>('minutes')
  const parsedValue = Number(customValue)
  const customMinutes = customUnit === 'hours' ? Math.round(parsedValue * 60) : Math.round(parsedValue)
  const validCustomTime = Number.isFinite(customMinutes) && customMinutes >= 1 && customMinutes <= 1440

  return (
    <div className="sleep-timer-backdrop" role="presentation" onClick={onClose}>
      <section className="sleep-timer-sheet" role="dialog" aria-modal="true" aria-labelledby="sleep-timer-title" onClick={event => event.stopPropagation()}>
        <div className="sleep-timer-handle" aria-hidden="true" />
        <div className="sleep-timer-heading">
          <span><IconClock size={22} /></span>
          <div><h2 id="sleep-timer-title">Sleep timer</h2><p>Playback stops when the timer ends.</p></div>
          <button type="button" onClick={onClose} aria-label="Close sleep timer">×</button>
        </div>

        {remainingSeconds > 0 && <div className="sleep-timer-active"><IconClock size={18} /><strong>{Math.ceil(remainingSeconds / 60)} minutes remaining</strong></div>}

        <div className="sleep-timer-quick" aria-label="Quick timer choices">
          {[15, 30, 45, 60].map(minutes => (
            <button type="button" key={minutes} onClick={() => onSet(minutes)}>{minutes === 60 ? '1 hour' : `${minutes} min`}</button>
          ))}
        </div>

        <div className="sleep-timer-custom">
          <label htmlFor="custom-timer-value">Custom time</label>
          <div>
            <input
              id="custom-timer-value"
              type="number"
              inputMode="decimal"
              min="1"
              max={customUnit === 'hours' ? '24' : '1440'}
              step={customUnit === 'hours' ? '0.25' : '1'}
              value={customValue}
              onChange={event => setCustomValue(event.target.value)}
              aria-describedby="custom-timer-help"
            />
            <select value={customUnit} onChange={event => setCustomUnit(event.target.value as 'minutes' | 'hours')} aria-label="Custom timer unit">
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
            </select>
          </div>
          <small id="custom-timer-help">Choose any duration up to 24 hours.</small>
          <button className="sleep-timer-set" type="button" disabled={!validCustomTime} onClick={() => validCustomTime && onSet(customMinutes)}>Set timer</button>
        </div>

        {remainingSeconds > 0 && <button className="sleep-timer-cancel" type="button" onClick={onCancel}>Cancel current timer</button>}
      </section>
    </div>
  )
}

function PlayerBar({
  track,
  isPlaying,
  onToggle,
  onNext,
  onPrev,
  shuffle,
  onToggleShuffle,
  repeat,
  onToggleRepeat,
  onOpenNowPlaying,
  playingFromDevice,
  onStop,
  progress,
  duration,
  volume,
  onSeek,
  onVolumeChange,
  activeSource,
  playbackStatus,
}: {
  track: Track | null
  isPlaying: boolean
  onToggle: () => void
  onNext: () => void
  onPrev: () => void
  shuffle: boolean
  onToggleShuffle: () => void
  repeat: boolean
  onToggleRepeat: () => void
  onOpenNowPlaying: () => void
  playingFromDevice: NasDevice | null
  onStop: () => void
  progress: number
  duration: number
  volume: number
  onSeek: (time: number) => void
  onVolumeChange: (volume: number) => void
  activeSource: PlaybackSource | null
  playbackStatus: 'idle' | 'loading' | 'ready' | 'error'
}) {
  const [sleepUntil, setSleepUntil] = useState<number | null>(null)
  const [sleepRemaining, setSleepRemaining] = useState(0)
  const [showSleepTimer, setShowSleepTimer] = useState(false)

  useEffect(() => {
    if (!sleepUntil) { setSleepRemaining(0); return }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((sleepUntil - Date.now()) / 1000))
      setSleepRemaining(remaining)
      if (remaining === 0) { setSleepUntil(null); onStop() }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [sleepUntil, onStop])

  if (!track) return null

  return (
    <>
    <div className={`player-bar ${track ? 'has-track' : ''}`} style={{ height: 80, background: '#0a0908', borderTop: '1px solid #2e2a24', display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', padding: '0 24px', gap: 24, flexShrink: 0 }}>
      {/* Track info */}
      <div className="player-track-info" style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
        {track ? (
          <>
            <div className="player-art"
              onClick={onOpenNowPlaying}
              style={{ width: 48, height: 48, borderRadius: 6, overflow: 'hidden', background: '#1a1815', flexShrink: 0, cursor: 'pointer' }}
            >
              <TrackArtwork track={track} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: '#e6e1d9', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {track.title}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                <span style={{ fontSize: 11, color: '#5a5248', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {track.artist}
                </span>
                {playingFromDevice && activeSource === 'synology' && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 10, padding: '1px 6px', borderRadius: 3,
                    background: '#1a1a2e',
                    border: '1px solid #2e2e4a',
                    color: '#7878c8',
                    whiteSpace: 'nowrap', flexShrink: 0,
                  }}>
                    <IconCloud size={9} />
                    {playingFromDevice.name}
                  </span>
                )}
                {activeSource === 'radio' && (
                  <span className="player-live-radio-badge"><i />LIVE</span>
                )}
              </div>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: '#3d3830' }}>—</div>
        )}
      </div>

      {/* Controls */}
      <div className="player-controls" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, minWidth: 320 }}>
        <div className="player-buttons" style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <button className={shuffle ? 'active' : ''} onClick={onToggleShuffle} style={{ background: 'none', border: 'none', cursor: 'pointer', color: shuffle ? '#d4924a' : '#5a5248', padding: 4 }}>
            <IconShuffle active={shuffle} />
          </button>
          <button className="previous-button" onClick={onPrev} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#a89880', padding: 4, opacity: track ? 1 : 0.3 }}>
            <IconSkipPrev />
          </button>
          <button className="primary-play-button"
            onClick={onToggle}
            disabled={!track}
            style={{
              width: 44, height: 44, borderRadius: '50%',
              background: track ? '#d4924a' : '#2e2a24',
              border: 'none', cursor: track ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#0e0d0c',
              transition: 'background 0.15s, transform 0.1s',
            }}
            onMouseDown={e => { if (track) e.currentTarget.style.transform = 'scale(0.93)' }}
            onMouseUp={e => { e.currentTarget.style.transform = 'scale(1)' }}
          >
            {isPlaying ? <IconPause size={20} /> : <IconPlay size={20} />}
          </button>
          <button className="next-button" onClick={onNext} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#a89880', padding: 4, opacity: track ? 1 : 0.3 }}>
            <IconSkipNext />
          </button>
          <button className={repeat ? 'active' : ''} onClick={onToggleRepeat} style={{ background: 'none', border: 'none', cursor: 'pointer', color: repeat ? '#d4924a' : '#5a5248', padding: 4 }}>
            <IconRepeat active={repeat} />
          </button>
        </div>

        {/* Progress */}
        {activeSource === 'radio' ? (
          <div className="player-radio-live-status"><i />LIVE STREAM</div>
        ) : (
          <div className="player-progress" style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
            <span style={{ fontSize: 10, color: '#5a5248', fontVariantNumeric: 'tabular-nums', minWidth: 28, textAlign: 'right' }}>
              {fmt(progress)}
            </span>
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                type="range"
                min={0}
                max={duration || 1}
                value={progress}
                onChange={e => onSeek(Number(e.target.value))}
                style={{ width: '100%', accentColor: '#d4924a' }}
              />
              <div style={{
                position: 'absolute', top: '50%', left: 0, height: 3,
                width: `${duration ? (progress / duration) * 100 : 0}%`,
                background: '#d4924a', borderRadius: 2, pointerEvents: 'none',
                transform: 'translateY(-50%)',
              }} />
            </div>
            <span style={{ fontSize: 10, color: '#5a5248', fontVariantNumeric: 'tabular-nums', minWidth: 28 }}>
              {fmtTrackDuration(duration)}
            </span>
          </div>
        )}
      </div>

      {/* Volume */}
      <div className="player-extras" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
        {playbackStatus === 'loading' && <span className="buffering-label">Loading</span>}
        <button className={`player-timer-button ${sleepUntil ? 'active' : ''}`} type="button" onClick={() => setShowSleepTimer(true)} aria-label={sleepUntil ? `${Math.ceil(sleepRemaining / 60)} minutes remaining on sleep timer` : 'Set sleep timer'}>
          <IconClock size={18} />
          <span>{sleepUntil ? `${Math.ceil(sleepRemaining / 60)} min` : 'Timer'}</span>
        </button>
        <span style={{ color: '#5a5248' }}><IconVolume level={volume} /></span>
        <div style={{ width: 90, position: 'relative' }}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={e => onVolumeChange(Number(e.target.value))}
            style={{ width: '100%', accentColor: '#d4924a' }}
          />
          <div style={{
            position: 'absolute', top: '50%', left: 0, height: 3,
            width: `${volume * 100}%`,
            background: '#d4924a', borderRadius: 2, pointerEvents: 'none',
            transform: 'translateY(-50%)',
          }} />
        </div>
      </div>
    </div>
    {showSleepTimer && (
      <SleepTimerSheet
        remainingSeconds={sleepRemaining}
        onSet={minutes => { setSleepUntil(Date.now() + minutes * 60_000); setShowSleepTimer(false) }}
        onCancel={() => { setSleepUntil(null); setShowSleepTimer(false) }}
        onClose={() => setShowSleepTimer(false)}
      />
    )}
    </>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App({ isPro = false }: { isPro?: boolean }) {
  const deviceProfile = useDeviceProfile()
  const [tracks, setTracks] = useState<Track[]>(() => readStored<Track[]>('tunestack:v2:tracks', []).map(track => ({ ...track, title: cleanTrackTitle(track.title || track.sourcePath || 'Unknown track') })))
  const [radioZip, setRadioZip] = useState(() => readStored<string>('tunestack:v1:radio-zip', ''))
  const [radioLocation, setRadioLocation] = useState(() => readStored<string>('tunestack:v1:radio-location', ''))
  const [radioTracks, setRadioTracks] = useState<Track[]>(() => readStored<Track[]>('tunestack:v1:radio-stations', []))
  const [view, setView] = useState<View>('settings')
  const [activeTrack, setActiveTrack] = useState<Track | null>(null)
  const [playbackQueue, setPlaybackQueue] = useState<Track[]>([])
  const [sessionRestored, setSessionRestored] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState(false)
  const [devices, setDevices] = useState<NasDevice[]>(() => {
    const sessions = readSessionStored<Record<string, string>>('tunestack:v1:synology-sessions', {})
    return readStored<NasDevice[]>('tunestack:v2:devices', INITIAL_DEVICES).map(device => ({
      ...device,
      sid: sessions[device.id] || undefined,
      status: 'checking' as NasStatus,
      connectionMessage: 'Checking this saved Synology connection…',
    }))
  })
  const [favorites, setFavorites] = useState<number[]>(() => readStored('tunestack:favorites', []))
  const [playlists, setPlaylists] = useState<Playlist[]>(() => readStored('tunestack:v2:playlists', INITIAL_PLAYLISTS))
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null)
  const [settings, setSettings] = useState<PlayerSettings>(() => {
    const stored = readStored<Partial<PlayerSettings>>('tunestack:v3:settings', {})
    const theme: PlayerTheme = stored.theme === 'apple-light' ? 'apple-light' : 'apple-dark'
    const availableAccents: PlayerAccent[] = ['pink', 'red', 'orange', 'purple', 'blue', 'teal', 'green']
    const accent: PlayerAccent = availableAccents.includes(stored.accent as PlayerAccent) ? stored.accent as PlayerAccent : 'pink'
    const lightColorMode: LightColorMode = stored.lightColorMode === 'artwork' ? 'artwork' : 'random'
    const storedOrder = (stored.navOrder || []).filter((item): item is NavView => DEFAULT_NAV_ORDER.includes(item as NavView))
    const navOrder = [...storedOrder, ...DEFAULT_NAV_ORDER.filter(item => !storedOrder.includes(item))]
    return { ...DEFAULT_SETTINGS, ...stored, theme, accent, lightColorMode, navOrder }
  })
  const [localKeys, setLocalKeys] = useState<string[]>([])
  useEffect(() => {
    if (localStorage.getItem('melodock:no-copy-migration-v2') === 'done') return
    const copiedImports = tracksRef.current.filter(track => track.origin === 'local' && !track.documentUri)
    void Promise.all(copiedImports.map(async track => {
      const db = await openLocalAudioDb()
      await new Promise<void>(resolve => { const request = db.transaction(LOCAL_STORE_NAME, 'readwrite').objectStore(LOCAL_STORE_NAME).delete(trackLocalKey(track)); request.onsuccess = () => resolve(); request.onerror = () => resolve() })
    })).finally(() => {
      const removed = new Set(copiedImports.map(trackLocalKey)); setTracks(items => items.filter(track => !removed.has(trackLocalKey(track)))); setLocalKeys(keys => keys.filter(key => !removed.has(key))); localStorage.setItem('melodock:no-copy-migration-v2', 'done')
    })
  }, [])
  const [requestedSource, setRequestedSource] = useState<PlaybackSource>('local')
  const [activeSource, setActiveSource] = useState<PlaybackSource | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [playbackStatus, setPlaybackStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [playbackError, setPlaybackError] = useState('')
  const [downloadState, setDownloadState] = useState<DownloadState>('idle')
  const [moodAnalysis, setMoodAnalysis] = useState<MoodAnalysisState>({ status: 'idle', completed: 0, total: 0, skipped: 0, message: '' })
  const [showLocalImport, setShowLocalImport] = useState(false)
  const [localImportState, setLocalImportState] = useState<LocalImportState>(EMPTY_LOCAL_IMPORT)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.75)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const objectUrlRef = useRef('')
  const moodJobRef = useRef<{ id: number; context: AudioContext | null }>({ id: 0, context: null })
  const tracksRef = useRef(tracks)
  const radioTracksRef = useRef(radioTracks)
  const artworkObjectUrlsRef = useRef<Map<string, string>>(new Map())
  const artworkJobsRef = useRef<Set<string>>(new Set())
  const metadataJobsRef = useRef<Set<string>>(new Set())
  const durationRepairAttemptsRef = useRef<Set<string>>(new Set())
  const [durationRepairPulse, setDurationRepairPulse] = useState(0)

  useEffect(() => {
    const availableViews: View[] = ['local', 'synology', 'radio', 'library', 'albums', 'moods', 'favorites', 'playlist', 'nowplaying', 'settings']
    const storedView = readStored<string>('tunestack:v4:last-view', '')
    const restorableTracks = [...tracksRef.current, ...radioTracksRef.current]
    const restoredView = availableViews.includes(storedView as View) ? storedView as View : tracksRef.current.length ? 'local' : radioTracksRef.current.length ? 'radio' : 'settings'
    const lastTrackKey = readStored<string>('tunestack:v4:last-track', '')
    const restoredTrack = restorableTracks.find(track => trackLocalKey(track) === lastTrackKey) ?? null
    const storedQueueKeys = readStored<string[]>('tunestack:v5:playback-queue', [])
    const tracksByKey = new Map(restorableTracks.map(track => [trackLocalKey(track), track]))
    const restoredQueue = storedQueueKeys.map(key => tracksByKey.get(key)).filter((track): track is Track => Boolean(track))
    const queueContainsRestoredTrack = restoredTrack && restoredQueue.some(track => trackLocalKey(track) === trackLocalKey(restoredTrack))
    const fallbackQueue = restoredTrack
      ? restorableTracks.filter(track => track.origin === restoredTrack.origin || (!track.origin && !restoredTrack.origin))
      : []
    setSelectedPlaylistId(readStored<string | null>('tunestack:v4:selected-playlist', null))
    setActiveTrack(restoredTrack)
    setPlaybackQueue(queueContainsRestoredTrack ? restoredQueue : fallbackQueue.length ? fallbackQueue : restoredTrack ? [restoredTrack] : [])
    setView(restoredView)
    setSessionRestored(true)
  }, [])

  useEffect(() => { localStorage.setItem('tunestack:favorites', JSON.stringify(favorites)) }, [favorites])
  useEffect(() => { localStorage.setItem('tunestack:v2:playlists', JSON.stringify(playlists)) }, [playlists])
  useEffect(() => { localStorage.setItem('tunestack:v3:settings', JSON.stringify(settings)) }, [settings])
  useEffect(() => { localStorage.setItem('tunestack:v1:radio-zip', JSON.stringify(radioZip)) }, [radioZip])
  useEffect(() => { localStorage.setItem('tunestack:v1:radio-location', JSON.stringify(radioLocation)) }, [radioLocation])
  useEffect(() => { localStorage.setItem('tunestack:v1:radio-stations', JSON.stringify(radioTracks)) }, [radioTracks])
  useEffect(() => {
    const sessions = Object.fromEntries(devices.filter(device => device.sid).map(device => [device.id, device.sid]))
    sessionStorage.setItem('tunestack:v1:synology-sessions', JSON.stringify(sessions))
  }, [devices])
  useEffect(() => {
    if (sessionRestored) localStorage.setItem('tunestack:v4:last-view', JSON.stringify(view))
  }, [sessionRestored, view])
  useEffect(() => {
    if (sessionRestored) localStorage.setItem('tunestack:v4:selected-playlist', JSON.stringify(selectedPlaylistId))
  }, [selectedPlaylistId, sessionRestored])
  useEffect(() => {
    if (activeTrack) localStorage.setItem('tunestack:v4:last-track', JSON.stringify(trackLocalKey(activeTrack)))
  }, [activeTrack])
  useEffect(() => {
    if (!sessionRestored) return
    localStorage.setItem('tunestack:v5:playback-queue', JSON.stringify(playbackQueue.map(trackLocalKey)))
  }, [playbackQueue, sessionRestored])
  useEffect(() => { tracksRef.current = tracks }, [tracks])
  useEffect(() => { radioTracksRef.current = radioTracks }, [radioTracks])
  useEffect(() => {
    listLocalAudioKeys().then(setLocalKeys).catch(() => setLocalKeys([]))
  }, [])
  useEffect(() => {
    let cancelled = false
    listTrackArtwork().then(records => {
      if (cancelled || !records.length) return
      const recordsByKey = new Map(records.map(record => [record.key, record]))
      setTracks(items => items.map(track => {
        const key = trackLocalKey(track)
        const record = recordsByKey.get(key)
        if (!record) return track
        const existingUrl = artworkObjectUrlsRef.current.get(key)
        const url = existingUrl || URL.createObjectURL(record.blob)
        artworkObjectUrlsRef.current.set(key, url)
        return { ...track, artworkKey: key, cover: url }
      }))
      setActiveTrack(current => {
        if (!current) return current
        const key = trackLocalKey(current)
        const record = recordsByKey.get(key)
        if (!record) return current
        const existingUrl = artworkObjectUrlsRef.current.get(key)
        const url = existingUrl || URL.createObjectURL(record.blob)
        artworkObjectUrlsRef.current.set(key, url)
        return { ...current, artworkKey: key, cover: url }
      })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!devices.length) return
    let cancelled = false
    const savedDevices = [...devices]

    void Promise.all(savedDevices.map(async device => {
      const result = await checkSynologyDevice(device)
      if (cancelled) return
      setDevices(items => items.map(item => item.id === device.id && item.status === 'checking' ? { ...item, ...result } : item))
    }))

    return () => { cancelled = true }
    // This startup check intentionally uses the saved devices from the first
    // render. Reconnect remains available while it runs, and its result cannot
    // overwrite a newer manual login.
  }, [])
  useEffect(() => {
    const savedDevices = devices.filter(device => device.saved !== false)
    const savedIds = new Set(savedDevices.map(device => device.id))
    const safeDevices = savedDevices.map(device => {
      const safeDevice = { ...device, saved: true }
      delete safeDevice.sid
      return safeDevice
    })
    const savedTracks = tracks
      .filter(track => track.origin === 'local' || track.sourceId === 'local-device' || !track.sourceId || savedIds.has(track.sourceId))
      .map(track => track.artworkKey && track.cover.startsWith('blob:') ? { ...track, cover: '/icon-512.png' } : track)
    localStorage.setItem('tunestack:v2:devices', JSON.stringify(safeDevices))
    localStorage.setItem('tunestack:v2:tracks', JSON.stringify(savedTracks))
  }, [devices, tracks])

  const playingFromDevice = activeTrack?.sourceId ? devices.find(device => device.id === activeTrack.sourceId) ?? null : null
  const localAvailable = activeTrack ? Boolean(activeTrack.documentUri) || localKeys.includes(trackLocalKey(activeTrack)) : false
  const localTracks = tracks.filter(track => track.origin === 'local' || Boolean(track.documentUri) || localKeys.includes(trackLocalKey(track)))
  const synologyTracks = tracks.filter(track => track.origin !== 'local' && track.origin !== 'radio' && Boolean(track.sourceId) && track.sourceId !== 'local-device')
  const activeTrackKey = activeTrack ? trackLocalKey(activeTrack) : ''
  const devicePlaybackKey = playingFromDevice
    ? `${playingFromDevice.id}|${playingFromDevice.sid || ''}|${playingFromDevice.baseUrl || ''}|${playingFromDevice.status}`
    : ''

  const cacheEmbeddedArtwork = useCallback(async (track: Track, audioBlob: Blob) => {
    const key = trackLocalKey(track)
    if (track.artworkKey || hasMeaningfulArtwork(track.cover) || artworkJobsRef.current.has(key)) return
    artworkJobsRef.current.add(key)
    try {
      const embedded = await extractEmbeddedArtwork(audioBlob)
      if (!embedded) return
      const normalized = await normalizeArtworkBlob(embedded)
      if (!normalized) return
      await saveTrackArtwork(track, normalized)
      const previousUrl = artworkObjectUrlsRef.current.get(key)
      if (previousUrl) URL.revokeObjectURL(previousUrl)
      const url = URL.createObjectURL(normalized)
      artworkObjectUrlsRef.current.set(key, url)
      const artworkUpdate: Partial<Track> = { artworkKey: key, cover: url }
      setTracks(items => items.map(item => trackLocalKey(item) === key ? { ...item, ...artworkUpdate } : item))
      setActiveTrack(current => current && trackLocalKey(current) === key ? { ...current, ...artworkUpdate } : current)
    } finally {
      artworkJobsRef.current.delete(key)
    }
  }, [])

  const cacheEmbeddedMetadata = useCallback(async (track: Track, audioBlob: Blob) => {
    const key = trackLocalKey(track)
    if (track.embeddedMetadataChecked || track.metadataSource === 'lyrics' || track.metadataSource === 'manual' || metadataJobsRef.current.has(key)) return
    metadataJobsRef.current.add(key)
    try {
      const embedded = await extractEmbeddedTrackMetadata(audioBlob)
      const metadataPatch: Partial<Track> = {
        embeddedMetadataChecked: true,
        ...(embedded?.title ? { title: embedded.title } : {}),
        ...(embedded?.artist ? { artist: embedded.artist } : {}),
        ...(embedded?.album ? { album: embedded.album } : {}),
        ...(embedded?.genre ? { genre: embedded.genre } : {}),
        ...(embedded?.year ? { year: embedded.year } : {}),
        ...(embedded?.title || embedded?.artist ? { metadataSource: 'file' as const } : {}),
      }
      const newestTrack = tracksRef.current.find(item => trackLocalKey(item) === key) || track
      const updatedTrack: Track = { ...newestTrack, ...metadataPatch }
      setTracks(items => items.map(item => trackLocalKey(item) === key ? { ...item, ...metadataPatch } : item))
      setActiveTrack(current => current && trackLocalKey(current) === key ? { ...current, ...metadataPatch } : current)
      await saveLocalAudio(updatedTrack, audioBlob)
    } finally {
      metadataJobsRef.current.delete(key)
    }
  }, [])

  useEffect(() => {
    const candidate = tracksRef.current.find(track => {
      const key = trackLocalKey(track)
      return track.duration <= 0 && localKeys.includes(key) && !durationRepairAttemptsRef.current.has(key)
    })
    if (!candidate) return

    const durationCandidate = candidate
    const candidateKey = trackLocalKey(durationCandidate)
    durationRepairAttemptsRef.current.add(candidateKey)
    let cancelled = false

    async function repairDuration() {
      try {
        const record = await readLocalAudio(durationCandidate)
        if (!record || cancelled) return
        const detectedDuration = await readAudioDuration(record.blob)
        if (!detectedDuration || cancelled) return
        const repairedTrack = { ...durationCandidate, duration: detectedDuration }
        setTracks(items => items.map(item => trackLocalKey(item) === candidateKey ? { ...item, duration: detectedDuration } : item))
        await saveLocalAudio(repairedTrack, record.blob)
      } catch {
        // Unsupported files remain playable and can report their length when loaded.
      } finally {
        if (!cancelled) setDurationRepairPulse(value => value + 1)
      }
    }

    repairDuration()
    return () => { cancelled = true }
  }, [durationRepairPulse, localKeys])

  useEffect(() => {
    if (!activeTrackKey) {
      audioRef.current?.pause()
      setAudioUrl('')
      setActiveSource(null)
      setPlaybackStatus('idle')
      return
    }
    const trackToLoad = tracksRef.current.find(track => trackLocalKey(track) === activeTrackKey)
      || radioTracksRef.current.find(track => trackLocalKey(track) === activeTrackKey)
      || activeTrack
    if (!trackToLoad) return
    const deviceToLoad = playingFromDevice
    let cancelled = false
    audioRef.current?.pause()
    setPlaybackStatus('loading')
    setPlaybackError('')
    setProgress(0)
    setDuration(trackToLoad.duration || 0)

    async function loadAudio(selectedTrack: Track) {
      try {
        if (selectedTrack.origin === 'radio') {
          const streamUrl = selectedTrack.radioUrl || ''
          if (!streamUrl.startsWith('https://')) throw new Error('This station does not provide a secure stream that can play in the app.')
          if (cancelled) return
          if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current)
            objectUrlRef.current = ''
          }
          setActiveSource('radio')
          setAudioUrl(streamUrl)
          setDuration(0)
          setPlaybackStatus('ready')
          return
        }

        if (selectedTrack.documentUri && requestedSource !== 'synology') {
          if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = '' }
          setActiveSource('local'); setAudioUrl(playableDocumentUrl(selectedTrack.documentUri)); setPlaybackStatus('ready'); return
        }
        const localRecord = await readLocalAudio(selectedTrack)
        let source: PlaybackSource
        let blob: Blob
        if (requestedSource === 'local' && localRecord) {
          source = 'local'
          blob = localRecord.blob
        } else if (requestedSource === 'synology' && deviceToLoad) {
          source = 'synology'
          blob = await fetchSynologyAudio(selectedTrack, deviceToLoad)
        } else if (localRecord) {
          source = 'local'
          blob = localRecord.blob
        } else if (deviceToLoad) {
          source = 'synology'
          blob = await fetchSynologyAudio(selectedTrack, deviceToLoad)
        } else {
          throw new Error('No playable Local or Synology copy is available for this track.')
        }
        if (cancelled) return
        void cacheEmbeddedArtwork(selectedTrack, blob)
        if (source === 'local') void cacheEmbeddedMetadata(selectedTrack, blob)
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
        const url = URL.createObjectURL(blob)
        objectUrlRef.current = url
        setActiveSource(source)
        setAudioUrl(url)
        setPlaybackStatus('ready')
      } catch (cause) {
        if (cancelled) return
        const message = cause instanceof Error ? cause.message : 'Audio playback could not be prepared.'
        if (deviceToLoad && /reconnect|session|sign in|permission/i.test(message)) {
          setDevices(items => items.map(device => device.id === deviceToLoad.id ? {
            ...device,
            sid: undefined,
            status: 'disconnected',
            connectionMessage: 'The DSM session is no longer valid. Reconnect in Settings to continue.',
            lastConnectionCheck: new Date().toISOString(),
          } : device))
        }
        setActiveSource(null)
        setPlaybackStatus('error')
        setPlaybackError(message)
        setIsPlaying(false)
      }
    }
    loadAudio(trackToLoad)
    return () => { cancelled = true }
  }, [activeTrackKey, requestedSource, devicePlaybackKey, localAvailable, cacheEmbeddedArtwork, cacheEmbeddedMetadata])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !audioUrl) return
    audio.volume = volume
    if (isPlaying) {
      audio.play().catch(cause => {
        setPlaybackStatus('error')
        setPlaybackError(cause instanceof Error ? cause.message : 'The browser blocked playback. Press Play again.')
        setIsPlaying(false)
      })
    } else {
      audio.pause()
    }
  }, [audioUrl, isPlaying, volume])

  useEffect(() => {
    const previousJob = moodJobRef.current
    previousJob.context?.close().catch(() => undefined)
    const jobId = previousJob.id + 1
    moodJobRef.current = { id: jobId, context: null }
    let cancelled = false
    let startTimer = 0
    const lyricsController = new AbortController()

    const shouldAnalyze = isPro && settings.autoAnalyzeLocal
      && Boolean(activeTrack)
      && activeTrack?.moodModelVersion !== MOOD_MODEL_VERSION
      && isPlaying
      && activeSource === 'local'
      && localAvailable
      && playbackStatus === 'ready'

    if (!shouldAnalyze || !activeTrack) {
      setMoodAnalysis(current => current.status === 'running'
        ? { status: 'idle', completed: 0, total: 0, skipped: 0, message: '' }
        : current)
      return () => { cancelled = true }
    }

    const target = activeTrack
    const targetKey = trackLocalKey(target)
    setMoodAnalysis({ status: 'running', completed: 0, total: 1, skipped: 0, message: `Listening across “${target.title}” and checking lyric cues…` })

    const runAnalysis = async () => {
      let context: AudioContext | null = null
      try {
        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        if (!AudioContextCtor) throw new Error('This browser does not support local audio analysis.')
        const record = target.documentUri
          ? { blob: await fetch(playableDocumentUrl(target.documentUri)).then(response => {
              if (!response.ok) throw new Error('Android could not read the linked music file.')
              return response.blob()
            }) }
          : await readLocalAudio(target)
        if (cancelled || moodJobRef.current.id !== jobId) return
        if (!record) throw new Error('The linked music file is unavailable. Reconnect its folder in Local Music.')
        if (record.blob.size > deviceProfile.maxAudioBytes) {
          throw new Error(`This ${Math.ceil(record.blob.size / 1024 / 1024)} MB file is above the safe ${Math.round(deviceProfile.maxAudioBytes / 1024 / 1024)} MB limit for this ${deviceProfile.deviceClass}.`)
        }
        const audioDuration = target.duration > 0 ? target.duration : await readAudioDuration(record.blob)
        if (cancelled || moodJobRef.current.id !== jobId) return
        if (audioDuration && audioDuration > deviceProfile.maxAudioSeconds) {
          throw new Error(`This ${Math.ceil(audioDuration / 60)} minute track is too long for safe analysis on this ${deviceProfile.deviceClass}.`)
        }
        const lyrics = await fetchLyricsForMood(target, audioDuration || target.duration || 0, lyricsController.signal)
        if (cancelled || moodJobRef.current.id !== jobId) return
        context = new AudioContextCtor()
        moodJobRef.current = { id: jobId, context }
        const result = await analyzeAudioMood(context, record.blob, lyrics)
        if (cancelled || moodJobRef.current.id !== jobId) return
        const analyzed: Partial<Track> = {
          mood: result.mood,
          moodConfidence: result.confidence,
          moodEnergy: result.energy,
          moodTempo: result.tempo,
          moodAnalyzedAt: new Date().toISOString(),
          moodAnalysisError: undefined,
          moodModelVersion: MOOD_MODEL_VERSION,
          moodLyricsUsed: result.lyricsUsed,
        }
        setTracks(items => items.map(item => trackLocalKey(item) === targetKey ? { ...item, ...analyzed } : item))
        setActiveTrack(current => current && trackLocalKey(current) === targetKey ? { ...current, ...analyzed } : current)
        // Persist only lightweight track metadata. Linked Android audio is never written to IndexedDB.
        if (!target.documentUri) await saveLocalAudio({ ...target, ...analyzed }, record.blob)
        setMoodAnalysis({
          status: 'done',
          completed: 1,
          total: 1,
          skipped: 0,
          message: `${result.mood} mood saved for “${target.title}”${result.lyricsUsed ? ' using audio and lyrics' : ' using its extended audio sample'}.`,
        })
      } catch (cause) {
        if (cancelled || moodJobRef.current.id !== jobId) return
        const reason = (cause instanceof Error ? `${cause.name}: ${cause.message}` : 'The browser could not decode this track.').slice(0, 180)
        setTracks(items => items.map(item => trackLocalKey(item) === targetKey ? { ...item, moodAnalysisError: reason } : item))
        setMoodAnalysis({ status: 'error', completed: 1, total: 1, skipped: 1, message: `Could not analyze “${target.title}”. ${reason} It will retry the next time this track plays.` })
      } finally {
        await context?.close().catch(() => undefined)
        if (moodJobRef.current.id === jobId) moodJobRef.current = { id: jobId, context: null }
      }
    }

    startTimer = window.setTimeout(runAnalysis, 900)
    return () => {
      cancelled = true
      lyricsController.abort()
      window.clearTimeout(startTimer)
      if (moodJobRef.current.id === jobId) {
        moodJobRef.current.context?.close().catch(() => undefined)
        moodJobRef.current = { id: jobId, context: null }
      }
    }
  }, [activeSource, activeTrack, deviceProfile.deviceClass, deviceProfile.maxAudioBytes, deviceProfile.maxAudioSeconds, isPlaying, isPro, localAvailable, playbackStatus, settings.autoAnalyzeLocal])


  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    artworkObjectUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
    artworkObjectUrlsRef.current.clear()
  }, [])

  const saveActiveMetadata = useCallback((title: string, artist: string) => {
    if (!activeTrackKey || !title.trim()) return
    const metadataPatch: Partial<Track> = {
      title: title.trim(),
      artist: artist.trim(),
      metadataSource: 'manual',
    }
    setTracks(items => items.map(item => trackLocalKey(item) === activeTrackKey ? { ...item, ...metadataPatch } : item))
    setActiveTrack(current => current && trackLocalKey(current) === activeTrackKey ? { ...current, ...metadataPatch } : current)
    void (async () => {
      const latestTrack = tracksRef.current.find(item => trackLocalKey(item) === activeTrackKey)
      if (!latestTrack) return
      const record = await readLocalAudio(latestTrack)
      if (record) await saveLocalAudio({ ...latestTrack, ...metadataPatch }, record.blob)
    })().catch(() => undefined)
  }, [activeTrackKey])

  const applyLyricsMetadata = useCallback((metadata: Pick<Track, 'title' | 'artist' | 'album'>) => {
    if (!activeTrackKey) return
    const metadataPatch: Partial<Track> = { ...metadata, metadataSource: 'lyrics' }
    setTracks(items => items.map(item => trackLocalKey(item) === activeTrackKey ? { ...item, ...metadataPatch } : item))
    setActiveTrack(current => current && trackLocalKey(current) === activeTrackKey ? { ...current, ...metadataPatch } : current)
    void (async () => {
      const latestTrack = tracksRef.current.find(item => trackLocalKey(item) === activeTrackKey)
      if (!latestTrack) return
      const record = await readLocalAudio(latestTrack)
      if (record) await saveLocalAudio({ ...latestTrack, ...metadataPatch }, record.blob)
    })().catch(() => undefined)
  }, [activeTrackKey])

  const toggleFavorite = useCallback((trackId: number) => {
    setFavorites(ids => ids.includes(trackId) ? ids.filter(id => id !== trackId) : [...ids, trackId])
  }, [])

  const addToPlaylist = useCallback((playlistId: string, trackId: number) => {
    setPlaylists(items => items.map(p => p.id === playlistId && !p.trackIds.includes(trackId) ? { ...p, trackIds: [...p.trackIds, trackId] } : p))
  }, [])

  const createPlaylistWithTrack = useCallback((trackId: number) => {
    const name = window.prompt('Name your new playlist')?.trim()
    if (!name) return
    const playlist: Playlist = { id: `${Date.now()}`, name, trackIds: [trackId] }
    setPlaylists(items => [...items, playlist])
    setSelectedPlaylistId(playlist.id)
  }, [])

  const createPlaylist = useCallback(() => {
    const name = window.prompt('Name your new playlist')?.trim()
    if (!name) return
    const playlist: Playlist = { id: `${Date.now()}`, name, trackIds: [] }
    setPlaylists(items => [...items, playlist])
    setSelectedPlaylistId(playlist.id)
    setView('playlist')
  }, [])

  const selectPlaylist = useCallback((id: string) => {
    setSelectedPlaylistId(id)
    setView('playlist')
  }, [])

  const saveRadioSearchResults = useCallback((nextZip: string, nextLocation: string, nextStations: Track[]) => {
    setRadioZip(nextZip)
    setRadioLocation(nextLocation)
    setRadioTracks(nextStations)
  }, [])

  const addSource = useCallback((device: NasDevice, discoveredTracks: Track[]) => {
    setDevices(items => [...items.filter(item => item.id !== device.id), device])
    setTracks(items => [...items.filter(track => track.sourceId !== device.id), ...discoveredTracks.map(track => ({ ...track, origin: 'synology' as const }))])
    setView('synology')
  }, [])

  const reconnectSource = useCallback((device: NasDevice) => {
    setDevices(items => items.map(item => item.id === device.id ? device : item))
  }, [])

  const removeSource = useCallback((id: string) => {
    setDevices(items => items.filter(device => device.id !== id))
    setTracks(items => items.filter(track => track.sourceId !== id))
    if (activeTrack?.sourceId === id) { setActiveTrack(null); setIsPlaying(false) }
  }, [activeTrack])

  const play = useCallback((track: Track, queue: Track[] = [track]) => {
    setPlaybackQueue(queue.length ? queue : [track])
    if (activeTrack?.id === track.id && activeTrack?.sourcePath === track.sourcePath) {
      setIsPlaying(p => !p)
    } else {
      setActiveTrack(track)
      setRequestedSource(track.origin === 'radio' ? 'radio' : settings.preferLocal ? 'local' : 'synology')
      setDownloadState('idle')
      setIsPlaying(true)
    }
  }, [activeTrack, settings.preferLocal])

  const togglePlay = useCallback(() => {
    if (activeTrack) setIsPlaying(p => !p)
  }, [activeTrack])

  const next = useCallback(() => {
    if (!activeTrack) return
    const queue = playbackQueue.length ? playbackQueue : [activeTrack]
    if (!queue.length) return
    const activeKey = trackLocalKey(activeTrack)
    const idx = queue.findIndex(track => trackLocalKey(track) === activeKey)
    let nextIndex = idx >= 0 ? (idx + 1) % queue.length : 0
    if (shuffle && queue.length > 1) {
      const candidates = queue.map((_, index) => index).filter(index => index !== idx)
      nextIndex = candidates[Math.floor(Math.random() * candidates.length)]
    }
    const nextTrack = queue[nextIndex]
    setActiveTrack(nextTrack)
    setRequestedSource(nextTrack.origin === 'radio' ? 'radio' : settings.preferLocal ? 'local' : 'synology')
    setDownloadState('idle')
    setProgress(0)
    setDuration(nextTrack.duration || 0)
    setIsPlaying(true)
  }, [activeTrack, playbackQueue, settings.preferLocal, shuffle])

  const prev = useCallback(() => {
    if (!activeTrack) return
    const queue = playbackQueue.length ? playbackQueue : [activeTrack]
    if (!queue.length) return
    const activeKey = trackLocalKey(activeTrack)
    const idx = queue.findIndex(track => trackLocalKey(track) === activeKey)
    const safeIndex = idx >= 0 ? idx : 0
    const previousTrack = queue[(safeIndex - 1 + queue.length) % queue.length]
    setActiveTrack(previousTrack)
    setRequestedSource(previousTrack.origin === 'radio' ? 'radio' : settings.preferLocal ? 'local' : 'synology')
    setDownloadState('idle')
    setProgress(0)
    setDuration(previousTrack.duration || 0)
    setIsPlaying(true)
  }, [activeTrack, playbackQueue, settings.preferLocal])

  const handleTrackEnded = useCallback(() => {
    if (repeat && audioRef.current) {
      audioRef.current.currentTime = 0
      setProgress(0)
      setIsPlaying(true)
      audioRef.current.play().catch(() => setIsPlaying(false))
      return
    }
    next()
  }, [next, repeat])

  const stop = useCallback(() => setIsPlaying(false), [])

  const seek = useCallback((time: number) => {
    if (!audioRef.current) return
    audioRef.current.currentTime = time
    setProgress(time)
  }, [])

  const changeVolume = useCallback((nextVolume: number) => {
    setVolume(nextVolume)
    if (audioRef.current) audioRef.current.volume = nextVolume
  }, [])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const mediaSession = navigator.mediaSession

    if (!activeTrack) {
      mediaSession.metadata = null
      mediaSession.playbackState = 'none'
      return
    }

    let artwork = '/icon-512.png'
    try {
      artwork = new URL(activeTrack.cover || '/icon-512.png', window.location.origin).toString()
    } catch {
      artwork = new URL('/icon-512.png', window.location.origin).toString()
    }

    mediaSession.metadata = new MediaMetadata({
      title: activeTrack.title,
      artist: activeTrack.artist,
      album: activeTrack.album,
      artwork: [{ src: artwork, sizes: '512x512' }],
    })
    mediaSession.playbackState = isPlaying && playbackStatus !== 'error' ? 'playing' : 'paused'

    const safelySetHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { mediaSession.setActionHandler(action, handler) } catch { /* Older Android versions support fewer actions. */ }
    }

    safelySetHandler('play', () => setIsPlaying(true))
    safelySetHandler('pause', () => setIsPlaying(false))
    safelySetHandler('stop', () => setIsPlaying(false))
    safelySetHandler('nexttrack', next)
    safelySetHandler('previoustrack', prev)
    safelySetHandler('seekbackward', details => seek(Math.max(0, (audioRef.current?.currentTime || 0) - (details.seekOffset || 10))))
    safelySetHandler('seekforward', details => seek(Math.min(duration || Number.MAX_SAFE_INTEGER, (audioRef.current?.currentTime || 0) + (details.seekOffset || 10))))
    safelySetHandler('seekto', details => {
      if (typeof details.seekTime === 'number') seek(details.seekTime)
    })

    return () => {
      ;(['play', 'pause', 'stop', 'nexttrack', 'previoustrack', 'seekbackward', 'seekforward', 'seekto'] as MediaSessionAction[])
        .forEach(action => safelySetHandler(action, null))
    }
  }, [activeTrack, duration, isPlaying, next, playbackStatus, prev, seek])

  useEffect(() => {
    let handle: { remove: () => Promise<void> } | null = null
    void listenForPlaybackCommands(command => {
      if (command === 'play') setIsPlaying(true)
      else if (command === 'pause' || command === 'stop') setIsPlaying(false)
      else if (command === 'next') next()
      else if (command === 'previous') prev()
    }).then(listener => { handle = listener })
    return () => { void handle?.remove() }
  }, [next, prev])

  useEffect(() => {
    if (!activeTrack) {
      void clearPlaybackNotification()
      return
    }
    void updatePlaybackNotification({
      title: activeTrack.title,
      artist: activeTrack.artist,
      album: activeTrack.album,
      playing: isPlaying && playbackStatus !== 'error',
    })
  }, [activeTrack, isPlaying, playbackStatus])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !activeTrack || !Number.isFinite(duration) || duration <= 0) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: audioRef.current?.playbackRate || 1,
        position: Math.min(Math.max(progress, 0), duration),
      })
    } catch {
      // Position state is optional on older Android browsers.
    }
  }, [activeTrack, duration, progress])

  const downloadActiveTrack = useCallback(async () => {
    if (!activeTrack || !playingFromDevice) return
    setDownloadState('downloading')
    setPlaybackError('')
    try {
      const blob = await fetchSynologyAudio(activeTrack, playingFromDevice)
      const detectedDuration = activeTrack.duration > 0 ? activeTrack.duration : await readAudioDuration(blob)
      const downloadedTrack = detectedDuration ? { ...activeTrack, duration: detectedDuration } : activeTrack
      await saveLocalAudio(downloadedTrack, blob)
      const key = trackLocalKey(activeTrack)
      if (detectedDuration) {
        setTracks(items => items.map(item => trackLocalKey(item) === key ? { ...item, duration: detectedDuration } : item))
      }
      setLocalKeys(keys => keys.includes(key) ? keys : [...keys, key])
      setDownloadState('done')
      setRequestedSource('local')
    } catch (cause) {
      setDownloadState('error')
      setPlaybackError(cause instanceof Error ? cause.message : 'The local download failed.')
    }
  }, [activeTrack, playingFromDevice])

  const importLocalDocuments = useCallback((documents: LocalDocument[], options: LocalImportOptions) => {
    if (!documents.length) return
    const imported = documents.map((document): Track => {
      const key = `document:${document.uri}`
      return { id: stableNumericId(key), title: document.title || cleanTrackTitle(document.name), artist: document.artist || 'Unknown artist', album: options.album || document.album || document.folderName || 'Local music', duration: Math.max(0, Math.round((document.durationMs || 0) / 1000)), year: document.year || 0, genre: document.genre || 'Local', cover: '/icon-512.png', sourceId: 'local-device', sourcePath: document.relativePath || document.name, origin: 'local', localKey: key, documentUri: document.uri, metadataSource: document.title || document.artist ? 'file' : 'filename', embeddedMetadataChecked: true }
    })
    setTracks(items => [...items.filter(item => !imported.some(track => track.localKey === item.localKey)), ...imported])
    const importedIds = imported.map(track => track.id)
    if (options.newPlaylist) { const playlist: Playlist = { id: `${Date.now()}`, name: options.newPlaylist, trackIds: importedIds }; setPlaylists(items => [...items, playlist]); setSelectedPlaylistId(playlist.id) }
    else if (options.playlistId) setPlaylists(items => items.map(item => item.id === options.playlistId ? { ...item, trackIds: Array.from(new Set([...item.trackIds, ...importedIds])) } : item))
    setLocalImportState({ status: 'done', total: documents.length, completed: documents.length, imported: documents.length, skipped: 0, message: `${documents.length} ${documents.length === 1 ? 'song' : 'songs'} linked without copying.` })
  }, [])

  const importLocalFiles = useCallback(async (files: File[] | FileList | null, options: LocalImportOptions) => {
    if (!files?.length) return
    const selectedFiles = Array.from(files)
    setLocalImportState({ status: 'importing', total: selectedFiles.length, completed: 0, imported: 0, skipped: 0, message: '' })
    const imported: Track[] = []
    const artworkCandidates: Array<{ track: Track; file: File }> = []
    const newKeys: string[] = []
    let skipped = 0
    let completed = 0
    for (const file of selectedFiles) {
      const extension = file.name.split('.').pop()?.toLowerCase() || ''
      if (!file.type.startsWith('audio/') && !AUDIO_EXTENSIONS.has(extension)) {
        skipped += 1
        completed += 1
        setLocalImportState({ status: 'importing', total: selectedFiles.length, completed, imported: imported.length, skipped, message: '' })
        continue
      }
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      const pathParts = relativePath.split('/').filter(Boolean)
      const folderAlbum = pathParts.length > 1 ? pathParts[pathParts.length - 2] : 'On this device'
      const folderArtist = pathParts.length > 2 ? pathParts[pathParts.length - 3] : ''
      const key = `local:${relativePath}:${file.size}:${file.lastModified}`
      const filenameTitle = cleanTrackTitle(file.name)
      const filenameParts = filenameTitle.match(/^(.+?)\s+-\s+(.+)$/)
      const embeddedMetadata = await extractEmbeddedTrackMetadata(file).catch(() => null)
      const title = embeddedMetadata?.title || filenameParts?.[2]?.trim() || filenameTitle
      const detectedDuration = await readAudioDuration(file)
      const track: Track = {
        id: stableTrackId(key),
        title,
        artist: embeddedMetadata?.artist || filenameParts?.[1]?.trim() || folderArtist || 'Unknown artist',
        album: options.album || embeddedMetadata?.album || folderAlbum,
        duration: detectedDuration || 0,
        year: embeddedMetadata?.year || 0,
        genre: embeddedMetadata?.genre || 'Local',
        cover: '/icon-512.png',
        sourceId: 'local-device',
        sourcePath: file.name,
        origin: 'local',
        localKey: key,
        metadataSource: embeddedMetadata?.title || embeddedMetadata?.artist ? 'file' : 'filename',
        embeddedMetadataChecked: true,
      }
      try {
        await saveLocalAudio(track, file)
        imported.push(track)
        artworkCandidates.push({ track, file })
        newKeys.push(key)
      } catch {
        skipped += 1
      }
      completed += 1
      setLocalImportState({ status: 'importing', total: selectedFiles.length, completed, imported: imported.length, skipped, message: '' })
      await new Promise<void>(resolve => window.setTimeout(resolve, 0))
    }
    if (imported.length) {
      setTracks(items => [...items.filter(item => !imported.some(track => track.localKey === item.localKey)), ...imported])
      setLocalKeys(keys => Array.from(new Set([...keys, ...newKeys])))
      const importedIds = imported.map(track => track.id)
      if (options.newPlaylist) {
        const playlist: Playlist = { id: `${Date.now()}`, name: options.newPlaylist, trackIds: importedIds }
        setPlaylists(items => [...items, playlist])
        setSelectedPlaylistId(playlist.id)
      } else if (options.playlistId) {
        setPlaylists(items => items.map(item => item.id === options.playlistId
          ? { ...item, trackIds: Array.from(new Set([...item.trackIds, ...importedIds])) }
          : item))
      }
      setView('local')
      setLocalImportState({ status: 'done', total: selectedFiles.length, completed, imported: imported.length, skipped, message: `${imported.length} ${imported.length === 1 ? 'track' : 'tracks'} added to Local Music.` })
      void (async () => {
        for (const candidate of artworkCandidates) {
          await cacheEmbeddedArtwork(candidate.track, candidate.file).catch(() => undefined)
          await new Promise<void>(resolve => window.setTimeout(resolve, 0))
        }
      })()
    } else {
      setLocalImportState({ status: 'error', total: selectedFiles.length, completed, imported: 0, skipped, message: 'No supported audio files could be added.' })
    }
  }, [cacheEmbeddedArtwork])

  const accentValues = { pink: '#fa2d65', red: '#ff453a', orange: '#ff9f0a', purple: '#bf5af2', blue: '#0a84ff', teal: '#5ac8fa', green: '#30d158' } as const
  const rootStyle = {
    display: 'flex', flexDirection: 'column', height: '100vh', background: '#0e0d0c', color: '#e6e1d9', fontFamily: "'DM Sans', system-ui, sans-serif", overflow: 'hidden',
    '--player-accent': accentValues[settings.accent],
  } as CSSProperties & { '--player-accent': string }
  const synologyNeedsReconnect = devices.find(device => device.status === 'disconnected' || device.status === 'error')

  return (
    <div
      className={`music-app mobile-shell view-${view} theme-${settings.theme} accent-${settings.accent} density-${settings.density} device-${deviceProfile.deviceClass} browser-${deviceProfile.browserSlug}`}
      data-device={deviceProfile.deviceClass}
      data-browser={deviceProfile.browserSlug}
      data-platform={deviceProfile.os}
      data-app-mode={deviceProfile.appMode === 'Installed app' ? 'standalone' : 'browser'}
      style={rootStyle}
    >
      <audio
        ref={audioRef}
        src={audioUrl || undefined}
        preload="metadata"
        onPlay={event => {
          if (!isPlaying) event.currentTarget.pause()
        }}
        onTimeUpdate={event => setProgress(event.currentTarget.currentTime || 0)}
        onLoadedMetadata={event => {
          const detectedDuration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0
          setDuration(detectedDuration)
          if (activeTrack && activeTrack.duration <= 0 && detectedDuration > 0) {
            const activeKey = trackLocalKey(activeTrack)
            setTracks(items => items.map(item => trackLocalKey(item) === activeKey ? { ...item, duration: detectedDuration } : item))
          }
        }}
        onEnded={handleTrackEnded}
        onError={() => {
          setPlaybackStatus('error')
          setPlaybackError(activeTrack?.origin === 'radio'
            ? 'This station’s live stream is temporarily unavailable. Try again or choose another station.'
            : 'The browser could not decode or play this audio format.')
          setIsPlaying(false)
        }}
      />
      {sessionRestored && synologyNeedsReconnect && view !== 'settings' && (
        <button className="synology-startup-alert" type="button" onClick={() => setView('settings')}>
          <span><IconServer size={18} /></span>
          <span><strong>{synologyNeedsReconnect.name} needs to reconnect</strong><small>{synologyNeedsReconnect.connectionMessage || 'Open Settings to refresh the DSM login without removing your library.'}</small></span>
          <b>Open Settings</b>
        </button>
      )}
      <div className="app-content" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar view={view} setView={setView} navOrder={settings.navOrder} />
        <main className="app-main" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {view === 'local' && (
            <LibraryView
              tracks={localTracks}
              activeTrack={activeTrack}
              isPlaying={isPlaying}
              onPlay={play}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              playlists={playlists}
              onAddToPlaylist={addToPlaylist}
              title="Local Files"
              emptyMessage="Download a Synology track or add audio files from this device."
              headerAction={<button className="android-add-music-button" type="button" aria-label="Add music from this device" onClick={() => { setLocalImportState(EMPTY_LOCAL_IMPORT); setShowLocalImport(true) }}><IconPlus size={18} /><span>Add music</span></button>}
            />
          )}
          {view === 'synology' && (
            <LibraryView tracks={synologyTracks} activeTrack={activeTrack} isPlaying={isPlaying} onPlay={play} favorites={favorites} onToggleFavorite={toggleFavorite} playlists={playlists} onAddToPlaylist={addToPlaylist} title="Synology" emptyMessage="Open Settings, connect your DiskStation, and scan the shared folders that contain music." />
          )}
          {view === 'radio' && (
            <RadioView
              zip={radioZip}
              location={radioLocation}
              stations={radioTracks}
              activeTrack={activeTrack}
              isPlaying={isPlaying}
              onSearchResults={saveRadioSearchResults}
              onPlay={play}
            />
          )}
          {view === 'moods' && (
            <MoodsView
              tracks={localTracks}
              activeTrack={activeTrack}
              isPlaying={isPlaying}
              onPlay={play}
            />
          )}
          {view === 'library' && (
            <LibraryView
              tracks={tracks}
              activeTrack={activeTrack}
              isPlaying={isPlaying}
              onPlay={play}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              playlists={playlists}
              onAddToPlaylist={addToPlaylist}
            />
          )}
          {view === 'favorites' && (
            <LibraryView tracks={tracks.filter(t => favorites.includes(t.id))} activeTrack={activeTrack} isPlaying={isPlaying} onPlay={play} favorites={favorites} onToggleFavorite={toggleFavorite} playlists={playlists} onAddToPlaylist={addToPlaylist} title="Favorites" />
          )}
          {view === 'playlist' && (() => {
            const playlist = playlists.find(p => p.id === selectedPlaylistId)
            const playlistTracks = playlist ? playlist.trackIds.map(id => tracks.find(t => t.id === id)).filter((t): t is Track => Boolean(t)) : []
            return <LibraryView tracks={playlistTracks} activeTrack={activeTrack} isPlaying={isPlaying} onPlay={play} favorites={favorites} onToggleFavorite={toggleFavorite} playlists={playlists} onAddToPlaylist={addToPlaylist} title={playlist?.name ?? 'Playlist'} />
          })()}
          {view === 'albums' && (
            <AlbumsView tracks={tracks} onPlay={(track, queue) => { play(track, queue); setView('nowplaying') }} />
          )}
          {view === 'nowplaying' && (
            <NowPlayingView
              track={activeTrack}
              isPlaying={isPlaying}
              onToggle={togglePlay}
              onNext={next}
              onPrev={prev}
              progress={progress}
              duration={duration}
              onSeek={seek}
              shuffle={shuffle}
              onToggleShuffle={() => setShuffle(value => !value)}
              repeat={repeat}
              onToggleRepeat={() => setRepeat(value => !value)}
              liked={activeTrack ? favorites.includes(activeTrack.id) : false}
              onToggleFavorite={() => { if (activeTrack) toggleFavorite(activeTrack.id) }}
              queue={playbackQueue.length ? playbackQueue : activeTrack ? [activeTrack] : []}
              onPlayFromQueue={queuedTrack => play(queuedTrack, playbackQueue.length ? playbackQueue : [queuedTrack])}
              playlists={playlists}
              onAddToPlaylist={addToPlaylist}
              onCreatePlaylist={createPlaylistWithTrack}
              playingFromDevice={playingFromDevice}
              localAvailable={localAvailable}
              activeSource={activeSource}
              onDownload={downloadActiveTrack}
              onReconnect={() => setView('settings')}
              downloadState={downloadState}
              playbackStatus={playbackStatus}
              playbackError={playbackError}
              lightColorMode={settings.lightColorMode}
              onSaveMetadata={saveActiveMetadata}
              updateMetadataFromLyrics={isPro && settings.updateMetadataFromLyrics}
              onApplyLyricsMetadata={applyLyricsMetadata}
            />
          )}
          {view === 'settings' && (
            <SettingsView
              settings={settings}
              isPro={isPro}
              onChange={setSettings}
              devices={devices}
              onAddSource={addSource}
              onReconnectSource={reconnectSource}
              onRemoveSource={removeSource}
              localTracks={localTracks}
              deviceProfile={deviceProfile}
              moodAnalysis={moodAnalysis}
              radioZip={radioZip}
              radioLocation={radioLocation}
              radioStationCount={radioTracks.length}
              onRadioSearchResults={saveRadioSearchResults}
            />
          )}
        </main>
      </div>
      <PlayerBar
        track={activeTrack}
        isPlaying={isPlaying}
        onToggle={togglePlay}
        onNext={next}
        onPrev={prev}
        shuffle={shuffle}
        onToggleShuffle={() => setShuffle(value => !value)}
        repeat={repeat}
        onToggleRepeat={() => setRepeat(value => !value)}
        onOpenNowPlaying={() => setView('nowplaying')}
        playingFromDevice={playingFromDevice}
        onStop={stop}
        progress={progress}
        duration={duration}
        volume={volume}
        onSeek={seek}
        onVolumeChange={changeVolume}
        activeSource={activeSource}
        playbackStatus={playbackStatus}
      />
      {showLocalImport && (
        <LocalImportSheet
          state={localImportState}
          onFiles={importLocalFiles}
          onDocuments={importLocalDocuments}
          onClose={() => setShowLocalImport(false)}
          onReset={() => setLocalImportState(EMPTY_LOCAL_IMPORT)}
          albums={Array.from(new Set(localTracks.map(track => track.album))).filter(Boolean).sort()}
          playlists={playlists}
        />
      )}
    </div>
  )
}
