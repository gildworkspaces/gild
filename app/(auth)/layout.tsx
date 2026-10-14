import Link from '@/components/Link'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <Link href="/" style={{ display: 'block', textAlign: 'center', fontWeight: 700, fontSize: 20, marginBottom: 28 }}>
          gild
        </Link>
        <div
          style={{
            border: '1px solid var(--rule)', borderRadius: 10,
            background: 'var(--panel)', padding: 28,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
