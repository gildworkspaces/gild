// Operator-only: run after the v2 site and renderer are deployed. Never invoked
// by a build or cron. Token stays in the environment and Authorization header.
import { pathToFileURL } from 'node:url'
export async function purgeV1({ token, account, zone, bucket = 'gild-fragments', origin = 'https://gild.gg', fetcher = fetch }) {
  if (!token || !account || !zone) throw Error('Set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ZONE_ID')
  const api = 'https://api.cloudflare.com/client/v4'
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
  let cursor = '', purged = 0
  do {
    const query = new URLSearchParams({ prefix: 'f/v1/', per_page: '1000', ...(cursor ? { cursor } : {}) })
    const response = await fetcher(`${api}/accounts/${account}/r2/buckets/${bucket}/objects?${query}`, { headers })
    const page = await response.json()
    if (!response.ok || page.success === false) throw Error(`R2 listing failed (HTTP ${response.status})`)
    const objects = page.result?.objects ?? page.result
    if (!Array.isArray(objects)) throw Error('Unexpected R2 listing response')
    const urls = objects.map(o => o.key ?? o.name).filter(key => typeof key === 'string' && key.startsWith('f/v1/'))
      .map(key => origin.replace(/\/$/, '') + '/' + key.split('/').map(encodeURIComponent).join('/'))
    for (let i = 0; i < urls.length; i += 100) {
      const result = await fetcher(`${api}/zones/${zone}/purge_cache`, { method: 'POST', headers, body: JSON.stringify({ files: urls.slice(i, i + 100) }) })
      const body = await result.json()
      if (!result.ok || !body.success) throw Error(`Cache purge failed (HTTP ${result.status})`)
      purged += Math.min(100, urls.length - i)
    }
    cursor = page.result_info?.is_truncated === false ? '' : page.result_info?.cursor ?? ''
    if (page.result_info?.is_truncated && !cursor) throw Error('Truncated R2 listing has no continuation cursor')
  } while (cursor)
  return purged
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = await purgeV1({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, zone: process.env.CLOUDFLARE_ZONE_ID })
  console.log(`Purged ${count} v1 fragment URLs`)
}
