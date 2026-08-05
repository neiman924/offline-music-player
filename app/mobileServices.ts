'use client'

import { CapacitorHttp } from '@capacitor/core'

type LrcRecord = {
  id: number
  trackName: string
  artistName: string
  albumName: string
  duration: number
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

type LyricsRequest = { title: string; artist: string; album: string; duration: number }

function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() }
function usableArtist(value: string) { const item = normalize(value); return Boolean(item && item !== 'unknown artist' && item !== 'local file') }
function cleanTitle(value: string) { return value.replace(/^\d+[ ._-]+/, '').replace(/\s*[\[(](?:feat\.?|ft\.?|featuring|remaster(?:ed)?|live|radio edit)[^\])]*[\])]/gi, '').trim() }
function cleanArtist(value: string) { return value.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim() }
function scoreLyrics(item: LrcRecord, request: LyricsRequest) {
  let score = 0
  const title = normalize(cleanTitle(request.title)); const artist = normalize(cleanArtist(request.artist))
  const foundTitle = normalize(item.trackName); const foundArtist = normalize(item.artistName)
  if (title === foundTitle) score += 12; else if (foundTitle.includes(title) || title.includes(foundTitle)) score += 6
  if (artist && artist === foundArtist) score += 9; else if (artist && (foundArtist.includes(artist) || artist.includes(foundArtist))) score += 4
  if (request.album && normalize(request.album) === normalize(item.albumName)) score += 3
  if (request.duration > 0 && Math.abs(item.duration - request.duration) <= 3) score += 5
  return score
}

async function nativeGet<T>(url: string): Promise<{ status: number; data: T }> {
  const result = await CapacitorHttp.get({
    url,
    headers: { Accept: 'application/json', 'User-Agent': 'Melodock/1.5 Android' },
    connectTimeout: 12_000,
    readTimeout: 15_000,
  })
  const data = typeof result.data === 'string' ? JSON.parse(result.data) as T : result.data as T
  return { status: result.status, data }
}

export async function lookupLyrics(request: LyricsRequest) {
  if (!request.title.trim()) return { found: false, message: 'A track title is required.' }
  const title = cleanTitle(request.title) || request.title
  const artist = cleanArtist(request.artist) || request.artist
  const queries = usableArtist(artist)
    ? [`track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`, `q=${encodeURIComponent(`${artist} ${title}`)}`]
    : [`q=${encodeURIComponent(title)}`]
  const records: LrcRecord[] = []
  for (const query of queries) {
    try {
      const response = await nativeGet<LrcRecord[]>(`https://lrclib.net/api/search?${query}`)
      if (response.status >= 200 && response.status < 300 && Array.isArray(response.data)) records.push(...response.data)
    } catch { /* Try the next provider/query. */ }
  }
  const unique = Array.from(new Map(records.map(item => [item.id, item])).values())
    .filter(item => item.instrumental || item.plainLyrics || item.syncedLyrics)
    .map(item => ({ item, score: scoreLyrics(item, request) }))
    .sort((a, b) => b.score - a.score)
  const best = unique[0]
  if (best && best.score >= (usableArtist(artist) ? 10 : 6)) return {
    found: true, id: best.item.id, trackName: best.item.trackName, artistName: best.item.artistName,
    albumName: best.item.albumName, instrumental: best.item.instrumental, plainLyrics: best.item.plainLyrics,
    syncedLyrics: best.item.syncedLyrics, provider: 'LRCLIB', sourceUrl: `https://lrclib.net/api/get/${best.item.id}`,
  }
  if (usableArtist(artist)) {
    try {
      const fallback = await nativeGet<{ lyrics?: string }>(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`)
      if (fallback.status === 200 && fallback.data.lyrics?.trim()) return { found: true, instrumental: false, plainLyrics: fallback.data.lyrics.trim(), syncedLyrics: null, provider: 'Lyrics.ovh' }
    } catch { /* Report the friendly no-match message below. */ }
  }
  return { found: false, message: 'No reliable lyrics match was found. Check the title and artist, then search again.' }
}

type ZipLookup = { places?: Array<{ 'place name'?: string; 'state abbreviation'?: string; latitude?: string; longitude?: string }> }
type RawStation = { stationuuid?: string; name?: string; url_resolved?: string; url?: string; homepage?: string; favicon?: string; tags?: string; state?: string; language?: string; codec?: string; bitrate?: number; hls?: number; lastcheckok?: number; geo_distance?: number }

export async function lookupRadio(zip: string) {
  if (!/^\d{5}$/.test(zip)) return { found: false, message: 'Enter a valid five-digit U.S. ZIP code.' }
  const locationResult = await nativeGet<ZipLookup>(`https://api.zippopotam.us/us/${zip}`)
  const place = locationResult.data.places?.[0]
  if (!place) return { found: false, message: 'That ZIP code could not be found.' }
  const latitude = Number(place.latitude); const longitude = Number(place.longitude)
  const params = new URLSearchParams({ countrycode: 'US', geo_lat: String(latitude), geo_long: String(longitude), geo_distance: '160934', hidebroken: 'true', is_https: 'true', limit: '200' })
  const response = await nativeGet<RawStation[]>(`https://all.api.radio-browser.info/json/stations/search?${params}`)
  const stations = (Array.isArray(response.data) ? response.data : []).filter(item => item.stationuuid && item.name && item.lastcheckok !== 0 && item.hls !== 1 && (item.url_resolved || item.url)).slice(0, 120).map(item => ({
    id: item.stationuuid!, name: item.name!.trim(), streamUrl: item.url_resolved || item.url || '', homepage: item.homepage || '', favicon: item.favicon || '', tags: (item.tags || '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 4), state: item.state || '', language: (item.language || '').split(',')[0], codec: item.codec || '', bitrate: Number(item.bitrate) || 0, distanceMiles: Math.round((Number(item.geo_distance) / 1609.344) * 10) / 10,
  }))
  const city = place['place name'] || zip; const state = place['state abbreviation'] || ''
  return { found: true, zip, location: state ? `${city}, ${state}` : city, radiusMiles: 100, stations, provider: 'Radio Browser' }
}
