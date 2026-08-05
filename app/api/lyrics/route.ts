import { NextResponse } from 'next/server'

export const runtime = 'edge'

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

const LRCLIB_API = 'https://lrclib.net/api'
const CLIENT_ID = 'TuneStack/1.1 (https://offline-music-player.neiman924.chatgpt.site)'

function clean(value: string | null, limit = 180) {
  return (value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit)
}

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function simplifiedTitle(value: string) {
  return value
    .replace(/^\d+[ ._-]+/, '')
    .replace(/\s*[\[(](?:feat\.?|ft\.?|featuring|remaster(?:ed)?|live|radio edit|bonus track)[^\])]*[\])]/gi, '')
    .replace(/\s+-\s+(?:remaster(?:ed)?|live|radio edit|bonus track).*$/i, '')
    .trim()
}

function simplifiedArtist(value: string) {
  return value.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim()
}

function usableArtist(value: string) {
  const normalizedArtist = normalized(value)
  return Boolean(normalizedArtist && normalizedArtist !== 'local file' && normalizedArtist !== 'unknown artist')
}

function matchScore(record: LrcRecord, title: string, artist: string, album: string, duration: number) {
  let score = 0
  const wantedTitle = normalized(title)
  const wantedArtist = normalized(artist)
  const wantedAlbum = normalized(album)
  const foundTitle = normalized(record.trackName)
  const foundArtist = normalized(record.artistName)
  const foundAlbum = normalized(record.albumName)
  if (wantedTitle === foundTitle) score += 12
  else if (foundTitle.includes(wantedTitle) || wantedTitle.includes(foundTitle)) score += 6
  if (wantedArtist && wantedArtist === foundArtist) score += 9
  else if (wantedArtist && (foundArtist.includes(wantedArtist) || wantedArtist.includes(foundArtist))) score += 4
  if (wantedAlbum && wantedAlbum === foundAlbum) score += 3
  if (duration > 0 && Math.abs(record.duration - duration) <= 3) score += 5
  return score
}

async function fetchLrclib(url: URL) {
  return fetch(url, {
    headers: {
      Accept: 'application/json',
      'Lrclib-Client': CLIENT_ID,
      'User-Agent': CLIENT_ID,
    },
    signal: AbortSignal.timeout(10_000),
  })
}

async function searchLrclib(parameters: Record<string, string>) {
  const url = new URL(`${LRCLIB_API}/search`)
  Object.entries(parameters).forEach(([key, value]) => value && url.searchParams.set(key, value))
  const response = await fetchLrclib(url)
  return response.ok ? await response.json() as LrcRecord[] : []
}

async function lyricsOvh(artist: string, title: string) {
  if (!usableArtist(artist)) return null
  const response = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, {
    headers: { Accept: 'application/json', 'User-Agent': CLIENT_ID },
    signal: AbortSignal.timeout(9_000),
  })
  if (!response.ok) return null
  const payload = await response.json() as { lyrics?: string; error?: string }
  return payload.lyrics?.trim() || null
}

export async function GET(request: Request) {
  const input = new URL(request.url).searchParams
  const title = clean(input.get('title'))
  const artist = clean(input.get('artist'))
  const album = clean(input.get('album'))
  const duration = Math.max(0, Math.round(Number(input.get('duration')) || 0))

  if (!title) return NextResponse.json({ found: false, message: 'A track title is required.' }, { status: 400 })

  const simpleTitle = simplifiedTitle(title) || title
  const simpleArtist = simplifiedArtist(artist) || artist

  try {
    let record: LrcRecord | null = null

    if (usableArtist(artist) && album && album !== 'On this device' && duration > 0) {
      const exactUrl = new URL(`${LRCLIB_API}/get`)
      exactUrl.searchParams.set('track_name', title)
      exactUrl.searchParams.set('artist_name', artist)
      exactUrl.searchParams.set('album_name', album)
      exactUrl.searchParams.set('duration', String(duration))
      const exactResponse = await fetchLrclib(exactUrl)
      if (exactResponse.ok) record = await exactResponse.json() as LrcRecord
    }

    if (!record) {
      const searches: Record<string, string>[] = []
      if (usableArtist(artist)) searches.push({ track_name: title, artist_name: artist })
      if (usableArtist(simpleArtist) && (simpleTitle !== title || simpleArtist !== artist)) searches.push({ track_name: simpleTitle, artist_name: simpleArtist })
      if (usableArtist(artist)) searches.push({ q: `${artist} ${title}` })
      if (usableArtist(simpleArtist)) searches.push({ q: `${simpleArtist} ${simpleTitle}` })
      searches.push({ q: simpleTitle })

      const results = (await Promise.all(searches.map(searchLrclib))).flat()
      const unique = Array.from(new Map(results.map(item => [item.id, item])).values())
        .filter(item => item.instrumental || item.plainLyrics || item.syncedLyrics)
      const ranked = unique
        .map(item => ({ item, score: matchScore(item, simpleTitle, simpleArtist, album, duration) }))
        .sort((a, b) => b.score - a.score)
      const minimumScore = usableArtist(simpleArtist) ? 10 : 6
      record = ranked[0]?.score >= minimumScore ? ranked[0].item : null
    }

    if (record) {
      return NextResponse.json({
        found: true,
        id: record.id,
        trackName: record.trackName,
        artistName: record.artistName,
        albumName: record.albumName,
        instrumental: record.instrumental,
        plainLyrics: record.plainLyrics,
        syncedLyrics: record.syncedLyrics,
        provider: 'LRCLIB',
        sourceUrl: `https://lrclib.net/api/get/${record.id}`,
      }, { headers: { 'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800' } })
    }

    const fallbackLyrics = await lyricsOvh(simpleArtist, simpleTitle)
    if (fallbackLyrics) {
      return NextResponse.json({
        found: true,
        instrumental: false,
        plainLyrics: fallbackLyrics,
        syncedLyrics: null,
        provider: 'Lyrics.ovh',
        sourceUrl: `https://api.lyrics.ovh/v1/${encodeURIComponent(simpleArtist)}/${encodeURIComponent(simpleTitle)}`,
      }, { headers: { 'Cache-Control': 'public, max-age=21600, stale-while-revalidate=86400' } })
    }

    return NextResponse.json({ found: false, message: 'No reliable lyrics match was found. Check the title and artist, then search again.' }, {
      headers: { 'Cache-Control': 'public, max-age=900' },
    })
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
    return NextResponse.json({
      found: false,
      message: timedOut ? 'The lyrics services took too long to answer.' : 'Lyrics are temporarily unavailable.',
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
  }
}
