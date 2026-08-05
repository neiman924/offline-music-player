'use client'
import { Capacitor, registerPlugin } from '@capacitor/core'
export interface LocalDocument { uri:string; name:string; relativePath:string; folderName:string; mimeType:string; size:number; title?:string; artist?:string; album?:string; genre?:string; year?:number; durationMs?:number }
interface LocalFolderPlugin { pickFolder():Promise<{documents:LocalDocument[]}>; pickFiles():Promise<{documents:LocalDocument[]}> }
const LocalFolder = registerPlugin<LocalFolderPlugin>('LocalFolder')
export function isNativeAndroid() { return Capacitor.getPlatform() === 'android' }
export function playableDocumentUrl(uri:string) { return Capacitor.convertFileSrc(uri) }
export async function pickLocalMusicFolder() { return (await LocalFolder.pickFolder()).documents || [] }
export async function pickLocalAudioFiles() { return (await LocalFolder.pickFiles()).documents || [] }
