import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { vaultService } from './vault.service'

class DbService {
  private clientInstance: SupabaseClient | null = null

  /**
   * Initializes or returns the cached Supabase client.
   * Pulls URL and Service Key dynamically from the vault.
   */
  public getClient(): SupabaseClient {
    if (this.clientInstance) {
      return this.clientInstance
    }

    let supabaseUrl = vaultService.getSecret('SUPABASE_URL')
    const supabaseKey =
      vaultService.getSecret('SUPABASE_SERVICE_ROLE_KEY') || vaultService.getSecret('SUPABASE_KEY')

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        'Supabase configuration missing. Please save Supabase URL and API Key in settings.'
      )
    }

    // Sanitize URL by removing trailing REST paths if configured incorrectly
    supabaseUrl = supabaseUrl.replace(/\/rest\/v1\/?$/, '').trim()

    this.clientInstance = createClient(supabaseUrl, supabaseKey, {
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
