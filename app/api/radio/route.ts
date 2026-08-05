import { NextResponse } from 'next/server'

export const runtime = 'edge'

type ZipLookup = {
  'post code'?: string
  places?: Array<{
    'place name'?: string
    state?: string
    'state abbreviation'?: string
    latitude?: string
    longitude?: string
  }>
}

type RadioBrowserStation = {
  stationuuid?: string
  name?: string
  url?: string
  url_resolved?: string
  homepage?: string
  favicon?: string
  tags?: string
  state?: string
  language?: string
  codec?: string
  bitrate?: number
  hls?: number
  votes?: number
  clickcount?: number
  lastcheckok?: number
  geo_lat?: number | null
  geo_long?: number | null
  geo_distance?: number | null
}

const RADIO_BROWSER_ROOTS = [
  'https://all.api.radio-browser.info',
  'https://de1.api.radio-browser.info',
]
const CLIENT_ID = 'TuneStack/1.2 (https://offline-music-player.neiman924.chatgpt.site)'
const SEARCH_RADIUS_METERS = 160_934

function safeHttpsUrl(value?: string) {
  if (!value) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function distanceMeters(latitude: number, longitude: number, stationLatitude?: number | null, stationLongitude?: number | null) {
  if (!Number.isFinite(stationLatitude) || !Number.isFinite(stationLongitude)) return Number.POSITIVE_INFINITY
  const toRadians = (degrees: number) => degrees * Math.PI / 180
  const earthRadius = 6_371_000
  const latitudeDelta = toRadians(Number(stationLatitude) - latitude)
  const longitudeDelta = toRadians(Number(stationLongitude) - longitude)
  const startLatitude = toRadians(latitude)
  const endLatitude = toRadians(Number(stationLatitude))
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2
  return earthRadius * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

async function fetchRadioStations(latitude: number, longitude: number) {
  const parameters = new URLSearchParams({
    countrycode: 'US',
    geo_lat: String(latitude),
    geo_long: String(longitude),
    geo_distance: String(SEARCH_RADIUS_METERS),
    hidebroken: 'true',
    is_https: 'true',
    limit: '300',
  })

  let lastError: unknown = null
  for (const root of RADIO_BROWSER_ROOTS) {
    try {
      const response = await fetch(`${root}/json/stations/search?${parameters}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': CLIENT_ID,
        },
        signal: AbortSignal.timeout(12_000),
      })
      if (!response.ok) throw new Error(`Radio directory returned HTTP ${response.status}.`)
      return await response.json() as RadioBrowserStation[]
    } catch (cause) {
      lastError = cause
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The radio directory is temporarily unavailable.')
}

export async function GET(request: Request) {
  const zip = new URL(request.url).searchParams.get('zip')?.trim() ?? ''
  if (!/^\d{5}$/.test(zip)) {
    return NextResponse.json({ found: false, message: 'Enter a valid five-digit U.S. ZIP code.' }, { status: 400 })
  }

  try {
    const zipResponse = await fetch(`https://api.zippopotam.us/us/${zip}`, {
      headers: { Accept: 'application/json', 'User-Agent': CLIENT_ID },
      signal: AbortSignal.timeout(8_000),
    })
    if (zipResponse.status === 404) {
      return NextResponse.json({ found: false, message: 'That ZIP code could not be found.' }, { status: 404 })
    }
    if (!zipResponse.ok) throw new Error('ZIP lookup is temporarily unavailable.')

    const zipPayload = await zipResponse.json() as ZipLookup
    const place = zipPayload.places?.[0]
    const latitude = Number(place?.latitude)
    const longitude = Number(place?.longitude)
    if (!place || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return NextResponse.json({ found: false, message: 'That ZIP code did not include a usable location.' }, { status: 404 })
    }

    const rawStations = await fetchRadioStations(latitude, longitude)
    const deduplicated = new Map<string, NonNullable<ReturnType<typeof normalizeStation>>>()

    for (const station of rawStations) {
      const normalized = normalizeStation(station, latitude, longitude)
      if (!normalized || normalized.distanceMeters > SEARCH_RADIUS_METERS) continue
      const duplicateKey = normalized.id || normalized.streamUrl.toLowerCase()
      const previous = deduplicated.get(duplicateKey)
      if (!previous || normalized.distanceMeters < previous.distanceMeters) deduplicated.set(duplicateKey, normalized)
    }

    const stations = Array.from(deduplicated.values())
      .sort((first, second) => first.distanceMeters - second.distanceMeters || second.popularity - first.popularity || first.name.localeCompare(second.name))
      .slice(0, 120)

    const city = place['place name']?.trim() || zip
    const state = place['state abbreviation']?.trim() || place.state?.trim() || ''
    return NextResponse.json({
      found: true,
      zip,
      location: state ? `${city}, ${state}` : city,
      radiusMiles: 100,
      stations,
      provider: 'Radio Browser',
    }, {
      headers: { 'Cache-Control': 'public, max-age=1800, stale-while-revalidate=21600' },
    })
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
    return NextResponse.json({
      found: false,
      message: timedOut ? 'The local radio search took too long. Please try again.' : 'Local radio search is temporarily unavailable.',
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
  }
}

function normalizeStation(station: RadioBrowserStation, latitude: number, longitude: number) {
  const id = station.stationuuid?.trim() || ''
  const name = station.name?.trim().replace(/\s+/g, ' ') || ''
  const streamUrl = safeHttpsUrl(station.url_resolved) || safeHttpsUrl(station.url)
  if (!id || !name || !streamUrl || station.lastcheckok === 0 || station.hls === 1) return null

  const calculatedDistance = distanceMeters(latitude, longitude, station.geo_lat, station.geo_long)
  const reportedDistance = Number(station.geo_distance)
  const stationDistance = Number.isFinite(reportedDistance) ? reportedDistance : calculatedDistance
  if (!Number.isFinite(stationDistance)) return null

  const tags = Array.from(new Set((station.tags || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(tag => tag && tag.length <= 32)))
    .slice(0, 4)

  return {
    id,
    name,
    streamUrl,
    homepage: safeHttpsUrl(station.homepage),
    favicon: safeHttpsUrl(station.favicon),
    tags,
    state: station.state?.trim() || '',
    language: station.language?.split(',')[0]?.trim() || '',
    codec: station.codec?.trim() || '',
    bitrate: Math.max(0, Number(station.bitrate) || 0),
    hls: station.hls === 1,
    distanceMeters: stationDistance,
    distanceMiles: Math.round((stationDistance / 1609.344) * 10) / 10,
    popularity: Math.max(0, Number(station.clickcount) || Number(station.votes) || 0),
  }
}
