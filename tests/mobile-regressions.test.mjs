import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const player = await readFile(new URL('../app/MusicPlayer.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8')
const manifest = await readFile(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
const service = await readFile(new URL('../android/app/src/main/java/com/neiman/tunestack/PlaybackService.kt', import.meta.url), 'utf8')

test('packaged mobile player does not call missing Next.js lyrics or radio routes', () => {
  assert.doesNotMatch(player, /fetch\(\s*[`'"]\/api\/(?:lyrics|radio)/)
})

test('linked folder mood analysis never persists the transient audio blob', () => {
  assert.match(player, /if \(!target\.documentUri\) await saveLocalAudio/)
  assert.match(player, /playableDocumentUrl\(target\.documentUri\)/)
})

test('Now Playing rotates generated and embedded artwork', () => {
  assert.match(styles, /immersive-record\.playing > \.generated-track-art/)
  assert.match(styles, /immersive-record\.playing > img/)
})

test('Android declares a foreground media playback service with controls', () => {
  assert.match(manifest, /foregroundServiceType="mediaPlayback"/)
  assert.match(service, /MediaStyle\(\)/)
  assert.match(service, /"Previous"/)
  assert.match(service, /"Next"/)
  assert.match(service, /FLAG_HANDLES_MEDIA_BUTTONS/)
  assert.match(service, /setPlaybackState/)
  assert.match(service, /override fun onPlay\(\)/)
  assert.match(service, /override fun onPause\(\)/)
})

test('Bluetooth connection cannot autoplay without an active Melodock track', () => {
  assert.match(service, /if \(hasTrack\) dispatchCommand\("play"\)/)
})
