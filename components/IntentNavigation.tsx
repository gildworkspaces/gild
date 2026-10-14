'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { PrefetchKind } from 'next/dist/client/components/router-reducer/router-reducer-types'
import { boot } from '../packages/render/router'
export function IntentNavigation() {
  const router = useRouter()
  useEffect(
    () =>
      boot((url) =>
        router.prefetch(url.pathname + url.search, { kind: PrefetchKind.FULL }),
      ),
    [router],
  )
  return null
}
