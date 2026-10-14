import { Missing } from '@/components/Missing'

// Anything missing under the portal outside /[owner] (e.g. a settings page
// asked for signed out) renders inside the portal layout, which already draws
// the header and footer. Without this boundary, notFound() falls through to
// app/not-found.tsx and the page gets a second header and footer.
// /[owner] keeps its own boundary: Next did not apply this one there.
export default function NotFound() {
  return <Missing />
}
