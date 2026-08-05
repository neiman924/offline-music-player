import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.neiman.tunestack',
  appName: 'Tunestack',
  webDir: 'native-shell',
  loggingBehavior: 'debug',
  appendUserAgent: ' TunestackAndroid/1.0',
  backgroundColor: '#0e0d0c',
  server: {
    url: 'https://offline-music-player.neiman924.chatgpt.site',
    allowNavigation: ['offline-music-player.neiman924.chatgpt.site'],
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0e0d0c',
    webContentsDebuggingEnabled: false,
    minWebViewVersion: 119,
  },
}

export default config
