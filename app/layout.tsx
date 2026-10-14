import { Suspense } from 'react'
import type { Metadata } from 'next'
import './globals.css'
import { fontCSS } from '../packages/presentation/fonts'
import assets from '../.render/assets.json'
import { IntentNavigation } from '@/components/IntentNavigation'
import { ThemeScript } from '@/components/theme'

export const metadata: Metadata = {
  title: 'gild',
  icons: { icon: '/favicon.svg', apple: '/apple-touch-icon.png' },
  description: 'A git platform for the agentic era. Metadata lives in the repo; identity lives in your terminal.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
        <style dangerouslySetInnerHTML={{ __html: fontCSS(assets.urls) }} />
        {['schibsted-grotesk', 'jetbrains-mono'].map((font) => <link key={font} rel="preload" href={assets.urls[(font+'.woff2') as keyof typeof assets.urls]} as="font" type="font/woff2" crossOrigin="anonymous" />)}
      </head>
      <body>
        <IntentNavigation />
        {/* Async layouts need a boundary in the initial shell before hydration starts. */}
        <Suspense fallback={null}>{children}</Suspense>
      </body>
    </html>
  )
}
