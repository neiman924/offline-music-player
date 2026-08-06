import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.neiman.melodock',
  appName: 'Melodock',
  webDir: 'native-shell',
  loggingBehavior: 'none',
  appendUserAgent: ' MelodockAndroid/1.5',
  backgroundColor: '#0e0d0c',
  android: {
    allowMixedContent: false,
    backgroundColor: '#0e0d0c',
    webContentsDebuggingEnabled: false,
    minWebViewVersion: 119,
  },
}

export default config
