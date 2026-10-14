import type { NextConfig } from 'next'
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare'

// D1 + other bindings available in `next dev`, same as on Workers.
initOpenNextCloudflareForDev()

const nextConfig: NextConfig = {}

export default nextConfig
