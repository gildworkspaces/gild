import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'
import { Missing } from '@/components/Missing'

// Any address that matches no page at all: same message, with the site's own header and footer.
export default function NotFound() {
  return (
    <>
      <SiteHeader name={null} />
      <main style={{ padding: '0 24px 24px', minWidth: 0 }}><Missing /></main>
      <Footer />
    </>
  )
}
