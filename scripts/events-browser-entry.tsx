import { createRoot } from 'react-dom/client'
import { Webhooks } from '../components/repo/Webhooks'
import '../app/globals.css'
createRoot(document.getElementById('app')!).render(
  <Webhooks owner="acme" repo="demo" />,
)
