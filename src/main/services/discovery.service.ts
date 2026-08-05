import os from 'os'
import net from 'net'

export class DiscoveryService {
  /**
   * Scans all active non-internal IPv4 subnets for devices listening on port 554 (RTSP).
   * Reports progress (0-100) and intermediate discovered IPs back via callback.
   */
  public async scanNetwork(
    onProgress: (percent: number, found: string[]) => void
  ): Promise<string[]> {
    const interfaces = os.networkInterfaces()
    const subnets: string[] = []

    // Find all active IPv4 interfaces that are not loopback/internal
    for (const name of Object.keys(interfaces)) {
      for (const netInterface of interfaces[name] || []) {
        if (netInterface.family === 'IPv4' && !netInterface.internal && netInterface.address) {
          const ip = netInterface.address
          const parts = ip.split('.')
          if (parts.length === 4) {
            // Reconstruct the /24 subnet prefix, e.g., '192.168.1'
            const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`
            if (!subnets.includes(subnet)) {
              subnets.push(subnet)
            }
          }
        }
      }
    }

    const foundIPs: string[] = []
    if (subnets.length === 0) {
      onProgress(100, foundIPs)
      return foundIPs
    }

    const maxHost = 254
    const batchSize = 30 // Max concurrent sockets to avoid file descriptor limits
    const connectTimeout = 400 // ms to wait for TCP connection

    const totalSteps = subnets.length * maxHost
    let completedSteps = 0

    // Helper to check if a TCP port is open on an IP address
    const checkPort = (ip: string, targetPort: number, timeout: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const socket = new net.Socket()
        let resolved = false

        const cleanup = () => {
          if (!resolved) {
            resolved = true
            socket.destroy()
          }
        }

        socket.setTimeout(timeout)

        socket.once('connect', () => {
          cleanup()
          resolve(true)
        })

        socket.once('error', () => {
          cleanup()
          resolve(false)
        })

        socket.once('timeout', () => {
          cleanup()
          resolve(false)
        })

        socket.connect(targetPort, ip)
      })
    }

    // Scan each subnet sequentially to avoid heavy load
    for (const subnet of subnets) {
      for (let i = 1; i <= maxHost; i += batchSize) {
        const promises: Promise<{ ip: string; open: boolean }>[] = []

        // Build a batch
        for (let j = 0; j < batchSize && i + j <= maxHost; j++) {
          const ip = `${subnet}.${i + j}`

          const checkHost = async (): Promise<{ ip: string; open: boolean }> => {
            const [open554, open8554] = await Promise.all([
              checkPort(ip, 554, connectTimeout),
              checkPort(ip, 8554, connectTimeout)
            ])
            return { ip, open: open554 || open8554 }
          }

          promises.push(checkHost())
        }

        // Run batch concurrently
        const results = await Promise.all(promises)
        completedSteps += promises.length

        // Process results
        for (const res of results) {
          if (res.open) {
            foundIPs.push(res.ip)
          }
        }

        // Send progress updates
        const percent = Math.min(100, Math.round((completedSteps / totalSteps) * 100))
        onProgress(percent, [...foundIPs])
      }
    }

    // Final call to ensure 100% is dispatched
    onProgress(100, foundIPs)
    return foundIPs
  }
}

export const discoveryService = new DiscoveryService()
