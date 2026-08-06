import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import MusicPlayer from '../app/MusicPlayer'
import { requestPlaybackNotificationPermission } from '../app/playbackNative'
import '../app/globals.css'

function MobileApp() {
  const [showWelcome, setShowWelcome] = useState(() => localStorage.getItem('melodock-permissions-v1') !== 'done')

  const finish = async (requestNotifications: boolean) => {
    if (requestNotifications) await requestPlaybackNotificationPermission()
    localStorage.setItem('melodock-permissions-v1', 'done')
    setShowWelcome(false)
  }

  return (
    <>
      <MusicPlayer isPro />
      {showWelcome && (
        <div role="dialog" aria-modal="true" aria-labelledby="permission-title" style={{position:'fixed',inset:0,zIndex:10000,display:'grid',placeItems:'center',padding:24,background:'rgba(0,0,0,.78)'}}>
          <section style={{maxWidth:520,padding:24,borderRadius:22,background:'#181614',color:'#fff',boxShadow:'0 24px 80px #000'}}>
            <h1 id="permission-title" style={{marginTop:0}}>Welcome to Melodock</h1>
            <p><strong>Music folders:</strong> when you import music, Android lets you choose a local folder. Melodock keeps a read-only link and plays files from that folder—it does not copy them.</p>
            <p><strong>Notifications:</strong> allow notifications to keep playback controls and the current song visible after you leave the app.</p>
            <p><strong>Internet:</strong> used only for features you choose, such as lyrics, radio, or Synology. Android grants this automatically.</p>
            <div style={{display:'flex',gap:10,justifyContent:'flex-end',flexWrap:'wrap'}}>
              <button onClick={() => void finish(false)} style={{padding:'11px 16px',borderRadius:12,border:'1px solid #665f58',background:'transparent',color:'#fff'}}>Not now</button>
              <button onClick={() => void finish(true)} style={{padding:'11px 16px',borderRadius:12,border:0,background:'#d59a55',color:'#17110a',fontWeight:700}}>Allow notifications</button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}

createRoot(document.getElementById('root')!).render(<MobileApp />)
