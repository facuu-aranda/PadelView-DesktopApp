import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { vaultService } from './vault.service'

class DbService {
  private clientInstance: SupabaseClient | null = null
  private currentAccessToken: string | null = null

  public setAccessToken(token: string | null) {
    this.currentAccessToken = token
    this.clientInstance = null // force recreate
  }

  /**
   * Initializes or returns the cached Supabase client.
   * Pulls URL and Service Key dynamically from the vault or env.
   */
  public getClient(): SupabaseClient {
    if (this.clientInstance) {
      return this.clientInstance
    }

    // Use environment variables as fallback if vault is not configured
    let supabaseUrl = vaultService.getSecret('SUPABASE_URL') || (import.meta as any).env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co'
    const supabaseKey =
      vaultService.getSecret('SUPABASE_KEY') || (import.meta as any).env.VITE_SUPABASE_ANON_KEY || 'eyPlaceholder'

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        'Supabase configuration missing.'
      )
    }

    // Sanitize URL by removing trailing REST paths if configured incorrectly
    supabaseUrl = supabaseUrl.replace(/\/rest\/v1\/?$/, '').trim()

    this.clientInstance = createClient(supabaseUrl, supabaseKey, {
      global: this.currentAccessToken
        ? {
            headers: {
              Authorization: `Bearer ${this.currentAccessToken}`
            }
          }
        : undefined,
      auth: {
        persistSession: false, // Desktop app doesn't need to persist browser auth state
        autoRefreshToken: false
      }
    })

    return this.clientInstance
  }

  /**
   * Force re-initialization of the database client (useful when settings change).
   */
  public resetClient(): void {
    this.clientInstance = null
  }
}

export const dbService = new DbService()
