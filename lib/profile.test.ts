import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePicture } from './profile.ts'
import { profileView } from './profile-view.ts'
import { memoryStore } from './drivers/memory.ts'

const hash = 'b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514'
test('picture resolution: upload wins over Gravatar', async () => {
  assert.deepEqual(
    await resolvePicture('/avatars/content-hash', 'user@example.com'),
    { url: '/avatars/content-hash', source: 'Uploaded' },
  )
})
test('picture resolution: no upload uses normalized SHA-256 Gravatar with d=404', async () => {
  assert.deepEqual(await resolvePicture(null, ' USER@Example.COM ', 44), {
    url: `https://www.gravatar.com/avatar/${hash}?s=44&d=404`,
    source: 'Gravatar',
  })
})
test('picture resolution: no upload and no email uses the silhouette', async () => {
  for (const email of [null, undefined, '', '   '])
    assert.deepEqual(await resolvePicture(null, email), {
      url: null,
      source: 'None',
    })
})
test('profile views use claim email for people and public email for orgs, returning no private email', async () => {
  const st = memoryStore()
  await st.prepareClaim('user', 'key', 'user@example.com', 'challenge')
  await st.finalizeClaim('challenge')
  const profile = {
    ...(await st.settings.profile('user')),
    publicEmail: 'public@example.com',
  }
  await st.settings.saveProfile('user', profile)
  const view = await profileView(st, 'user')
  assert.match(view.picture.url!, new RegExp(hash))
  assert.ok(!JSON.stringify(view).includes('user@example.com'))
  await st.createOrg('acme', null, 'user')
  assert.deepEqual((await profileView(st, 'acme', true)).picture, {
    url: null,
    source: 'None',
  })
  await st.settings.saveProfile('acme', {
    ...profile,
    publicEmail: 'user@example.com',
  })
  assert.match(
    (await profileView(st, 'acme', true)).picture.url!,
    new RegExp(hash),
  )
})
