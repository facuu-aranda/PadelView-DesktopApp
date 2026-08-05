import { createClient } from '@supabase/supabase-js'

// Para MVP, estas variables pueden venir de import.meta.env
// O ser inyectadas desde el main process si se desea mantener ocultas.
// Asumimos que se proveerán mediante .env en el renderer.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://tu-proyecto.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'ey...'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
