import { NextResponse } from 'next/server'

export const runtime = 'edge'

type ConnectionMode = 'local' | 'ddns' | 'quickconnect'

type ProxyRequest = {
  mode?: ConnectionMode
  host?: string
  port?: string
  quickConnectId?: string
  params?: Record<string, string>
}

type QuickConnectReply = {
  errno?: number
  env?: { control_host?: string; relay_region?: string }
  server?: {
    ddns?: string
    fqdn?: string
    ds_state?: string
  }
  service?: {
    port?: number
    ext_port?: number
    relay_dn?: string
    relay_dualstack?: string
    relay_port?: number
    https_port?: number
  }
  smartdns?: {
    host?: string
    external?: string
  }
}

const quickConnectCache = new Map<string, { baseUrl: string; expiresAt: number }>()
const ALLOWED_APIS = new Set(['SYNO.API.Info', 'SYNO.API.Auth', 'SYNO.FileStation.List', 'SYNO.FileStation.Download'])
const ALLOWED_METHODS = new Set(['query', 'login', 'logout', 'list_share', 'list', 'download'])

function jsonError(message: string, status = 400, code = 'BAD_REQUEST') {
  return NextResponse.json({ success: false, error: { message, code } }, { status })
}

function cleanHost(value: string) {
  const trimmed = value.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '')
  return trimmed.split('/')[0].split(':')[0].toLowerCase()
}

function validPublicHostname(host: string) {
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)) return false
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false
  return true
}

function validPort(value: string) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535
}

function quickConnectBody(command: 'get_server_info' | 'request_tunnel', quickConnectId: string) {
  return [
    {
      version: 1,
      command,
      stop_when_error: false,
      stop_when_success: false,
      id: 'dsm_portal_https',
      serverID: quickConnectId,
      is_gofile: false,
    },
  ]
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

function addCandidate(candidates: string[], host?: string, port?: number) {
  if (!host || host === 'NULL') return
  const normalized = cleanHost(host)
  if (!validPublicHostname(normalized)) return
  const baseUrl = `https://${normalized}${port && port !== 443 ? `:${port}` : ''}`
  if (!candidates.includes(baseUrl)) candidates.push(baseUrl)
}

function candidatesFrom(reply: QuickConnectReply, quickConnectId: string) {
  const candidates: string[] = []
  const servicePort = reply.service?.ext_port || reply.service?.port || 5001
  addCandidate(candidates, reply.smartdns?.host, servicePort)
  addCandidate(candidates, reply.smartdns?.external, servicePort)
  addCandidate(candidates, reply.server?.ddns, servicePort)
  addCandidate(candidates, reply.server?.fqdn, servicePort)
  addCandidate(candidates, `${quickConnectId}.direct.quickconnect.to`, 443)
  if (reply.env?.relay_region) addCandidate(candidates, `${quickConnectId}.${reply.env.relay_region}.quickconnect.to`, 443)
  addCandidate(candidates, reply.service?.relay_dn, reply.service?.https_port || 443)
  addCandidate(candidates, reply.service?.relay_dualstack, reply.service?.https_port || 443)
  return candidates
}

async function testDsmCandidate(baseUrl: string) {
  try {
    const url = new URL('/webman/pingpong.cgi', baseUrl)
    url.searchParams.set('action', 'cors')
    url.searchParams.set('quickconnect', 'true')
    const response = await fetchWithTimeout(url.toString(), { method: 'GET' }, 3500)
    if (!response.ok) return false
    const payload = await response.json() as { success?: boolean }
    return payload.success === true
  } catch {
    return false
  }
}

async function firstReachable(candidates: string[]) {
  for (const candidate of candidates) {
    if (await testDsmCandidate(candidate)) return candidate
  }
  return null
}

async function queryQuickConnect(host: string, command: 'get_server_info' | 'request_tunnel', quickConnectId: string) {
  const safeHost = cleanHost(host)
  if (!(safeHost === 'global.quickconnect.to' || safeHost.endsWith('.quickconnect.to'))) {
    throw new Error('QuickConnect returned an invalid control host.')
  }
  const response = await fetchWithTimeout(`https://${safeHost}/Serv.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(quickConnectBody(command, quickConnectId)),
  })
  if (!response.ok) throw new Error('Synology QuickConnect lookup is unavailable.')
  const payload = await response.json() as QuickConnectReply[]
  const reply = payload.find(item => item.errno === 0)
  if (!reply || reply.server?.ds_state === 'DISCONNECTED') throw new Error('QuickConnect ID was not found or the NAS is offline.')
  return reply
}

async function resolveQuickConnect(quickConnectId: string) {
  const cached = quickConnectCache.get(quickConnectId)
  if (cached && cached.expiresAt > Date.now()) return cached.baseUrl

  const info = await queryQuickConnect('global.quickconnect.to', 'get_server_info', quickConnectId)
  let baseUrl = await firstReachable(candidatesFrom(info, quickConnectId))

  if (!baseUrl) {
    const controlHost = info.env?.control_host || 'global.quickconnect.to'
    const tunnel = await queryQuickConnect(controlHost, 'request_tunnel', quickConnectId)
    baseUrl = await firstReachable(candidatesFrom(tunnel, quickConnectId))
  }

  if (!baseUrl) throw new Error('QuickConnect located the NAS, but no DSM HTTPS route accepted API traffic. Enable DSM access in QuickConnect Advanced Settings or use DDNS.')
  quickConnectCache.set(quickConnectId, { baseUrl, expiresAt: Date.now() + 10 * 60 * 1000 })
  return baseUrl
}

export async function POST(request: Request) {
  let input: ProxyRequest
  try {
    input = await request.json() as ProxyRequest
  } catch {
    return jsonError('The connection request was not valid JSON.')
  }

  const mode = input.mode
  const params = input.params
  if (!mode || mode === 'local') return jsonError('Local connections must be made directly from your browser.')
  if (!params || !ALLOWED_APIS.has(params.api) || !ALLOWED_METHODS.has(params.method)) {
    return jsonError('This DSM API operation is not allowed.')
  }
  if ((params.api === 'SYNO.API.Info') !== (params.method === 'query')) {
    return jsonError('This DSM API operation is not allowed.')
  }
  if (params.api === 'SYNO.FileStation.Download') {
    let paths: unknown = null
    try { paths = JSON.parse(params.path || '') } catch { paths = null }
    if (params.method !== 'download' || !Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== 'string' || !paths[0].startsWith('/') || !params._sid || params.path.length > 4096 || params._sid.length > 1024) {
      return jsonError('The audio download request is incomplete.')
    }
  }

  let baseUrl: string
  try {
    if (mode === 'quickconnect') {
      const id = input.quickConnectId?.trim() ?? ''
      if (!/^[A-Za-z][A-Za-z0-9-]{0,62}[A-Za-z0-9]$|^[A-Za-z]$/.test(id)) {
        return jsonError('Enter a valid QuickConnect ID.')
      }
      baseUrl = await resolveQuickConnect(id)
    } else {
      const host = cleanHost(input.host ?? '')
      const port = input.port || '5001'
      if (!validPublicHostname(host)) return jsonError('Enter a public DDNS hostname, such as your-name.synology.me.')
      if (!validPort(port)) return jsonError('Enter a valid DSM HTTPS port.')
      baseUrl = `https://${host}${port === '443' ? '' : `:${port}`}`
    }

    const dsmUrl = new URL('/webapi/entry.cgi', baseUrl)
    const isDownload = params.api === 'SYNO.FileStation.Download' && params.method === 'download'
    const response = await fetchWithTimeout(dsmUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'Cache-Control': 'no-store',
      },
      body: new URLSearchParams(params),
    }, isDownload ? 120000 : params.method === 'list' ? 30000 : 12000)

    if (isDownload) {
      if (!response.ok || !response.body) return jsonError(`DSM could not download this audio file (HTTP ${response.status}).`, 502, 'DOWNLOAD_FAILED')
      const headers = new Headers()
      headers.set('Content-Type', response.headers.get('Content-Type') || 'application/octet-stream')
      headers.set('Cache-Control', 'private, no-store')
      const length = response.headers.get('Content-Length')
      if (length) headers.set('Content-Length', length)
      return new NextResponse(response.body, { status: 200, headers })
    }

    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return jsonError('DSM answered, but the response was not a DSM API response. Check the hostname, port, and reverse-proxy path.', 502, 'INVALID_DSM_RESPONSE')
    }
    return NextResponse.json(payload, { status: response.ok ? 200 : 502, headers: { 'Cache-Control': 'no-store' } })
  } catch (cause) {
    const message = cause instanceof Error && cause.name === 'AbortError'
      ? 'The NAS connection timed out. Confirm that the address is reachable from the internet.'
      : cause instanceof Error ? cause.message : 'The NAS could not be reached.'
    return jsonError(message, 502, 'NAS_UNREACHABLE')
  }
}
