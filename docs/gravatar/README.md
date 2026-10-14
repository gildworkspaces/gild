# Profile pictures

Sami's decision: uploaded picture → Gravatar if it exists → generic silhouette.
`lib/profile.ts` owns resolution; `components/Picture.tsx` owns rendering and image
failure. `lib/profile-view.ts` reads claim email on the server for people and public
email for organizations. Only a hash URL crosses the picture's client boundary.
The same component covers account/org settings and the context switcher, account
Organizations, public profiles, People/Overview, Members, rail/site identity,
Contributors matching a gild account, and agent silhouettes. PR/issue author views
currently have no pictures. The old bands function and initials component are gone.

The picture column uses the existing Zega account profile layout (the name/email
form with a secondary avatar column), already adopted by settings #31. Source is
Uploaded, Gravatar, or None; the missing state offers only a Set up Gravatar link.
Use Gravatar removes the upload pointer through the existing picture route.

## API and caching

| Route | Access | Response |
| --- | --- | --- |
| `DELETE /api/v1/user/picture` | Authenticated claimed account, unrestricted admin token | 200 profile with `picture: null` |
| `DELETE /api/v1/orgs/{org}/picture` | Owner/admin, same as PUT | 200 profile with `picture: null` |

Cookie adapters: `/api/account/picture` and `/api/orgs/{org}/picture`.
The production cookie CSRF gate runs before writes. Others receive 404 on the org
route; the account route always targets its caller. DELETE is idempotent and
preserves profile fields and uploaded bytes, so immutable content-hash URLs stay
readable until the existing unreferenced-blob GC grace period expires. The canonical
contract feeds OpenAPI and the generated client; no separate route list was added.

Gravatar requests use normalized SHA-256 and `d=404`, directly from the browser,
without a proxy or server-side existence fetch. Gravatar owns response caching.
See [Gravatar's image API](https://docs.gravatar.com/sdk/images/).
A live request to the documented example returned 200 with `max-age=300`; an absent
hash returned 404 with `d=404`. Mutable viewer/profile pointers keep the existing
no-store page behavior. Repo commit summaries retain their existing immutable
caches; only the eight displayed contributors need picture lookups.

An independent browser probe without image interception measured the uploaded URL
at 593.4 ms on reload and 1.0 ms from cache; transfer size was 898 then 0 bytes,
with `public, max-age=31536000, immutable` on both responses. Dynamic Overview
navigation measured 314/463 ms. These samples were taken under integration load;
they establish the browser cache hit rather than a page-speed improvement.

## Verification

```sh
npm test
npx tsc --noEmit
npm run test:gravatar:revert
npm run test:gravatar:browser
npm run build:cloudflare
npm run test:gravatar:local
npm run test:settings:local
node scripts/settings-local.mjs --dispatch-race
```

Resolution tests cover upload priority, normalized Gravatar URLs, missing email,
and claim-vs-public-email selection. Revert proof removes the Gravatar step and
separately puts Gravatar before uploads; each named effect test fails. DELETE tests
run against both memory and SQLite-backed D1, preserving profiles/blobs and checking
owner/admin/member/outsider permissions and CSRF through actual dispatch.

The browser component test delays hydration until after a 404, then checks the SVG
fallback and transitions through present/missing Gravatar, upload, and no email.
The Worker fixture uses production HTML, auth, D1, uploads, deletes and routing;
only external Gravatar 200/404 image responses are controlled with the existing
public avatar asset. No test claims these disposable fixture emails have live
Gravatars. It checks both cookie DELETE forms, changing org public email, mixed
pictures, the switcher/rail, and full HTML including streamed client props as both
an anonymous visitor and a signed-in outsider. Forbidden Members settings are 404.

The full settings fixture now runs the Gravatar scenario after rename/dispatch,
using the renamed organization. It waits for the actual Actions read endpoint to become ready
after native Git push before asserting a 201 workflow dispatch, and after the
archived-fetch fixture directly adds another Git ref. `receive-pack`
schedules refresh asynchronously; API repository authorization uses `readyIndex`
and returns 404 while that index is refreshing or its ref-advertisement cache
has not converged. The extra Gravatar work changed
this race's timing. Removing only the mid-suite call yielded 201 and the complete
lifecycle (then the expected missing-account-DELETE coverage assertion); restoring
the original call also passed on a fresh build, establishing an intermittent
failure rather than deterministic profile corruption.

The `--dispatch-race` fixture uses the production index with a delayed refresh
alarm after real account/org DELETEs and both renames. With the readiness wait it
returns 201; removing that wait fails with `404 !== 201` and `Repository not found`.
The full suite retains every lifecycle and response-contract assertion. Picture
writes and product authorization remain unchanged. Lazy images are scrolled into
view before full-page screenshots; hidden menu images need not load.

## Screenshots

[All screenshots](screenshots/) cover light/dark at 1400/400 px, without horizontal
overflow. Source variants are generated by the actual production app and the
controlled external image responses above. Solid blue and striped pictures are
uploaded fixture images.

| Area | Light desktop | Dark mobile |
| --- | --- | --- |
| Account, uploaded | [1400](screenshots/account-uploaded-1400-light.png) | [400](screenshots/account-uploaded-400-dark.png) |
| Account, Gravatar | [1400](screenshots/account-gravatar-1400-light.png) | [400](screenshots/account-gravatar-400-dark.png) |
| Account, none | [1400](screenshots/account-none-1400-light.png) | [400](screenshots/account-none-400-dark.png) |
| Mixed Members | [1400](screenshots/members-1400-light.png) | [400](screenshots/members-400-dark.png) |
| Organization Overview | [1400](screenshots/overview-1400-light.png) | [400](screenshots/overview-400-dark.png) |
| Organization, Gravatar | [1400](screenshots/org-gravatar-1400-light.png) | [400](screenshots/org-gravatar-400-dark.png) |

-codex
