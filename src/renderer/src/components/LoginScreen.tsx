import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import logoPng from '../assets/logo.png'

interface LoginScreenProps {
  onLogin: (session: any) => void
}

export default function LoginScreen({ onLogin }: LoginScreenProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Listen for deep link IPC event
    const handleDeepLink = async (_event: any, url: string) => {
      console.log('Received deep link:', url)
      setLoading(true)
      try {
        const urlObj = new URL(url)
        // If it's hash-based (implicit flow):
        if (urlObj.hash) {
          const params = new URLSearchParams(urlObj.hash.substring(1))
          const accessToken = params.get('access_token')
          const refreshToken = params.get('refresh_token')
          if (accessToken && refreshToken) {
            const { data, error } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken
            })
            if (error) throw error
            if (data.session) onLogin(data.session)
          }
        } else if (urlObj.searchParams.get('code')) {
          // PKCE flow
          const code = urlObj.searchParams.get('code')
          if (code) {
            const { data, error } = await supabase.auth.exchangeCodeForSession(code)
            if (error) throw error
            if (data.session) onLogin(data.session)
          }
        }
      } catch (err: any) {
        console.error(err)
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    if (window.electron) {
      // @ts-ignore
      window.electron.ipcRenderer.on('auth:deep-link', handleDeepLink)
    }

    // Check if we already have a session
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        onLogin(session)
      }
    })

    return () => {
      if (window.electron) {
        // @ts-ignore
        window.electron.ipcRenderer.removeAllListeners('auth:deep-link')
      }
    }
  }, [onLogin])

  const handleGoogleLogin = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: 'viewpadel://login', // Matches Supabase redirect URI
          skipBrowserRedirect: true // Don't replace current electron window
        }
      })
      if (error) throw error
      if (data?.url) {
        if (window.electron) {
          // @ts-ignore
          await window.electron.ipcRenderer.invoke('auth:open-url', data.url)
        } else {
          // Fallback para web
          window.location.href = data.url
        }
        // Wait for the deep link to return
      }
    } catch (err: any) {
      console.error(err)
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh',
      backgroundColor: '#0B0F19', color: 'white', padding: '20px', position: 'relative'
    }}>
      {/* CSS para el fondo de la web y la animación del logo */}
      <style>{`
        @keyframes rotate-slow {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes rotate-fast {
          0% { transform: rotate(0deg) scale(1.1); }
          100% { transform: rotate(360deg) scale(1.1); }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }
        @keyframes gradient-text {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .login-fade-in {
          animation: fade-in 0.8s ease-out forwards;
        }
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .btn-google:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 20px rgba(255,255,255,0.1);
        }
        .logo-container {
          margin: 0 auto 20px auto;
          width: 100px;
          height: 100px;
          display: flex;
          align-items: center;
          justify-content: center;
          animation: float 4s ease-in-out infinite;
        }
        .logo-img {
          width: 100%;
          height: 100%;
          object-fit: contain;
          animation: rotate-slow 15s linear infinite;
          transition: all 0.3s ease;
          filter: drop-shadow(0 0 15px rgba(16,185,129,0.4));
        }
        .logo-container:hover .logo-img {
          animation: rotate-fast 2s linear infinite;
          filter: drop-shadow(0 0 30px rgba(16,185,129,0.8));
        }

        /* Tech Sports Background */
        .page-bg {
          position: absolute; top: 0; left: 0; right: 0; bottom: 0;
          z-index: 0; overflow: hidden; pointer-events: none;
        }
        .bg-orb {
          position: absolute; border-radius: 50%; filter: blur(80px); opacity: 0.15;
        }
        .orb-1 { width: 600px; height: 600px; background: #10b981; top: -200px; left: -200px; }
        .orb-2 { width: 500px; height: 500px; background: #3b82f6; bottom: -100px; right: -100px; }
        .grid-lines {
          position: absolute; inset: 0;
          background-image: 
            linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px);
          background-size: 50px 50px;
          mask-image: radial-gradient(circle at center, black 30%, transparent 80%);
          -webkit-mask-image: radial-gradient(circle at center, black 30%, transparent 80%);
        }
      `}</style>
      
      <div className="page-bg">
        <div className="bg-orb orb-1"></div>
        <div className="bg-orb orb-2"></div>
        <div className="grid-lines"></div>
      </div>

      <div className="login-fade-in" style={{
        backgroundColor: 'rgba(15, 23, 42, 0.6)', padding: '50px 40px', borderRadius: '24px', width: '100%', maxWidth: '420px', textAlign: 'center',
        backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)', zIndex: 1
      }}>
        
        {/* Animated Logo */}
        <div className="logo-container">
          <img src={logoPng} alt="ViewPadel Logo" className="logo-img" />
        </div>

        <h1 style={{
          fontSize: '36px', fontWeight: '800', margin: '0 0 12px 0',
          background: 'linear-gradient(90deg, #3b82f6, #10b981)', backgroundSize: '200% auto',
          color: 'transparent', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          animation: 'gradient-text 3s ease infinite'
        }}>
          ViewPadel
        </h1>
        <p style={{ color: '#94a3b8', fontSize: '15px', marginBottom: '35px', lineHeight: '1.5' }}>
          Control de Canchas, Grabación en Vivo y Automatización Inteligente.
        </p>
        
        {error && (
          <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#f87171', padding: '12px', borderRadius: '8px', fontSize: '14px', marginBottom: '20px', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
            {error}
          </div>
        )}

        <button
          className="btn-google"
          onClick={handleGoogleLogin}
          disabled={loading}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
            backgroundColor: 'rgba(255,255,255,0.05)', color: 'white', padding: '16px', borderRadius: '12px',
            fontSize: '16px', fontWeight: '600', cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1, border: '1px solid rgba(255,255,255,0.1)', transition: 'all 0.3s ease'
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.16v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.16C1.43 8.55 1 10.22 1 12s.43 3.45 1.16 4.93l2.85-2.22.83-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.16 7.07l3.68 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          {loading ? 'Revisando navegador...' : 'Ingresar con Google'}
        </button>
      </div>
    </div>
  )
}
